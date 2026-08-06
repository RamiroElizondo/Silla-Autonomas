import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Silla } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShellyService } from '../shelly/shelly.service';

/** Minutos que se reserva la silla mientras el cliente paga. */
export const TIMEOUT_PAGO_MIN = 3;

/**
 * Máquina de estados de la silla:
 *
 *   LIBRE → PAGO_PENDIENTE → EN_USO → LIBRE
 *            (timeout 3min)   (timeout duracionMin)
 *
 * Este servicio es el ÚNICO que transiciona estados y maneja timers.
 * Al reiniciar el servidor, reconstruye los timers desde la DB.
 */
@Injectable()
export class SesionesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SesionesService.name);
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly shelly: ShellyService,
  ) {}

  // ── Recuperación tras reinicio ────────────────────────────────

  async onApplicationBootstrap() {
    // Sesiones activas: reprogramar apagado (o apagar ya si venció)
    const activas = await this.prisma.sesion.findMany({
      where: { estado: 'ACTIVA' },
    });
    for (const sesion of activas) {
      const fin = sesion.finProgramado ?? new Date();
      if (fin <= new Date()) {
        this.logger.warn(`Sesión ${sesion.id} venció durante reinicio, apagando`);
        await this.finalizarSesion(sesion.id, 'completada_tras_reinicio');
      } else {
        this.programar(sesion.id, fin, () =>
          this.finalizarSesion(sesion.id, 'tiempo_cumplido'),
        );
        this.logger.log(`Sesión ${sesion.id} reprogramada hasta ${fin.toISOString()}`);
      }
    }

    // Sesiones esperando pago: reprogramar o expirar
    const pendientes = await this.prisma.sesion.findMany({
      where: { estado: 'PENDIENTE' },
    });
    for (const sesion of pendientes) {
      const limite = new Date(
        sesion.creadaEn.getTime() + TIMEOUT_PAGO_MIN * 60_000,
      );
      if (limite <= new Date()) {
        await this.expirarPagoPendiente(sesion.id);
      } else {
        this.programar(sesion.id, limite, () =>
          this.expirarPagoPendiente(sesion.id),
        );
      }
    }
  }

  // ── LIBRE → PAGO_PENDIENTE ────────────────────────────────────

  /**
   * Reserva la silla y crea la sesión que espera el pago.
   * Update condicional (estado: LIBRE) evita race condition si dos
   * clientes tocan "Pagar" al mismo tiempo.
   */
  async crearSesionPendiente(silla: Silla, externalReference: string) {
    const reservada = await this.prisma.silla.updateMany({
      where: { id: silla.id, estado: 'LIBRE' },
      data: { estado: 'PAGO_PENDIENTE' },
    });
    if (reservada.count === 0) {
      throw new ConflictException('La silla no está libre en este momento');
    }

    const sesion = await this.prisma.sesion.create({
      data: {
        sillaId: silla.id,
        externalReference,
        monto: silla.precio,
        duracionMin: silla.duracionMin,
      },
    });

    const limite = new Date(Date.now() + TIMEOUT_PAGO_MIN * 60_000);
    this.programar(sesion.id, limite, () => this.expirarPagoPendiente(sesion.id));
    this.logger.log(`Silla ${silla.nombre}: PAGO_PENDIENTE (sesión ${sesion.id})`);
    return sesion;
  }

  // ── PAGO_PENDIENTE → EN_USO ───────────────────────────────────

  /** Activa la sesión: enciende el relé y programa el apagado. */
  async activarSesion(sesionId: string) {
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion) throw new NotFoundException('Sesión no encontrada');
    if (sesion.estado === 'ACTIVA') return sesion; // idempotente
    if (sesion.estado !== 'PENDIENTE') {
      throw new ConflictException(`Sesión en estado ${sesion.estado}, no activable`);
    }

    this.cancelarTimer(sesionId); // cancela la expiración de pago

    const inicio = new Date();
    const finProgramado = new Date(inicio.getTime() + sesion.duracionMin * 60_000);

    // Primero el relé: si Shelly falla, no cobramos tiempo que no corre.
    // (El pago ya está hecho: el admin ve la alerta y puede activar manualmente.)
    await this.shelly.setRele(sesion.silla.deviceIdShelly, true);

    const [actualizada] = await this.prisma.$transaction([
      this.prisma.sesion.update({
        where: { id: sesionId },
        data: { estado: 'ACTIVA', inicio, finProgramado },
      }),
      this.prisma.silla.update({
        where: { id: sesion.sillaId },
        data: { estado: 'EN_USO', finSesionActual: finProgramado },
      }),
    ]);

    this.programar(sesionId, finProgramado, () =>
      this.finalizarSesion(sesionId, 'tiempo_cumplido'),
    );
    this.logger.log(
      `Silla ${sesion.silla.nombre}: EN_USO hasta ${finProgramado.toISOString()}`,
    );
    return actualizada;
  }

  /** Activación manual desde el panel admin (sin pago). */
  async activarManual(sillaId: string, duracionMin?: number) {
    const silla = await this.prisma.silla.findUnique({ where: { id: sillaId } });
    if (!silla) throw new NotFoundException('Silla no encontrada');
    if (silla.estado === 'EN_USO') {
      throw new ConflictException('La silla ya está en uso');
    }

    const sesion = await this.prisma.sesion.create({
      data: {
        sillaId,
        externalReference: `manual-${crypto.randomUUID()}`,
        monto: 0,
        duracionMin: duracionMin ?? silla.duracionMin,
        esManual: true,
      },
    });
    return this.activarSesion(sesion.id);
  }

  // ── EN_USO → LIBRE ────────────────────────────────────────────

  /** Corta la corriente y libera la silla. */
  async finalizarSesion(sesionId: string, motivo: string) {
    this.cancelarTimer(sesionId);

    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion || sesion.estado !== 'ACTIVA') return;

    try {
      await this.shelly.setRele(sesion.silla.deviceIdShelly, false);
    } catch (e) {
      // Fallback: el Shelly tiene auto-off configurado; se apaga solo.
      this.logger.error(
        `No se pudo apagar el relé de ${sesion.silla.nombre}; actúa el auto-off del Shelly. ${e}`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.sesion.update({
        where: { id: sesionId },
        data: { estado: 'COMPLETADA', finReal: new Date(), motivoCierre: motivo },
      }),
      this.prisma.silla.update({
        where: { id: sesion.sillaId },
        data: { estado: 'LIBRE', finSesionActual: null },
      }),
    ]);
    this.logger.log(`Silla ${sesion.silla.nombre}: LIBRE (${motivo})`);
  }

  /** Parada de emergencia: corta ya, marca la sesión como CANCELADA. */
  async detenerEmergencia(sillaId: string) {
    const silla = await this.prisma.silla.findUnique({ where: { id: sillaId } });
    if (!silla) throw new NotFoundException('Silla no encontrada');

    await this.shelly.setRele(silla.deviceIdShelly, false);

    const activa = await this.prisma.sesion.findFirst({
      where: { sillaId, estado: 'ACTIVA' },
    });
    if (activa) {
      this.cancelarTimer(activa.id);
      await this.prisma.sesion.update({
        where: { id: activa.id },
        data: {
          estado: 'CANCELADA',
          finReal: new Date(),
          motivoCierre: 'parada_de_emergencia',
        },
      });
    }
    await this.prisma.silla.update({
      where: { id: sillaId },
      data: { estado: 'LIBRE', finSesionActual: null },
    });
    this.logger.warn(`Parada de emergencia en silla ${silla.nombre}`);
    return { ok: true, sillaId, sesionCancelada: activa?.id ?? null };
  }

  // ── PAGO_PENDIENTE → LIBRE (timeout) ──────────────────────────

  async expirarPagoPendiente(sesionId: string) {
    this.cancelarTimer(sesionId);

    // Solo expira si sigue PENDIENTE (si el pago llegó justo, no toca nada)
    const expirada = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'PENDIENTE' },
      data: {
        estado: 'CANCELADA',
        finReal: new Date(),
        motivoCierre: 'pago_no_recibido',
      },
    });
    if (expirada.count === 0) return;

    const sesion = await this.prisma.sesion.findUnique({ where: { id: sesionId } });
    if (sesion) {
      await this.prisma.silla.updateMany({
        where: { id: sesion.sillaId, estado: 'PAGO_PENDIENTE' },
        data: { estado: 'LIBRE' },
      });
    }
    this.logger.log(`Sesión ${sesionId} expirada sin pago, silla liberada`);
  }

  // ── Timers ────────────────────────────────────────────────────

  private programar(sesionId: string, cuando: Date, fn: () => Promise<void>) {
    this.cancelarTimer(sesionId);
    const ms = Math.max(0, cuando.getTime() - Date.now());
    this.timers.set(
      sesionId,
      setTimeout(() => {
        this.timers.delete(sesionId);
        fn().catch((e) => this.logger.error(`Error en timer de ${sesionId}: ${e}`));
      }, ms),
    );
  }

  private cancelarTimer(sesionId: string) {
    const t = this.timers.get(sesionId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(sesionId);
    }
  }
}
