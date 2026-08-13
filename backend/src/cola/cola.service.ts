import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { MercadoPagoService } from '../mercadopago/mercadopago.service';
import { PrismaService } from '../prisma/prisma.service';
import { SesionesService } from '../sesiones/sesiones.service';
import { generarCodigo } from './codigo.util';

/** Minutos que se espera el pago de un turno antes de cancelarlo. */
export const TIMEOUT_PAGO_TURNO_MIN = 3;
/** Minutos de ventana para confirmar presencia una vez asignada una silla. */
export const VENTANA_CONFIRMACION_MIN = 2;

/**
 * Cola compartida entre todas las sillas del local. Se paga al anotarse
 * (no al confirmar). Cuando una silla queda LIBRE, se le asigna al turno
 * más antiguo en EN_COLA — con una ventana de confirmación antes de pasar
 * al siguiente. No usa WebSocket: el frontend hace polling del estado del
 * turno, igual que ya hace con el estado de una silla.
 *
 * Este servicio es el ÚNICO que transiciona estados de Turno y silla.estado
 * === 'RESERVADA'. Reintenta la asignación con un timer periódico (en vez
 * de que SesionesService le avise cuando libera una silla) para no crear
 * una dependencia circular entre los dos servicios.
 */
@Injectable()
export class ColaService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ColaService.name);
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly backendUrlFallback: string;
  private readonly frontendUrlFallback: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mp: MercadoPagoService,
    private readonly sesiones: SesionesService,
    config: ConfigService,
  ) {
    this.backendUrlFallback = config.get<string>('BACKEND_URL', '');
    this.frontendUrlFallback = config.get<string>('FRONTEND_URL', '');
  }

  // ── Recuperación tras reinicio ────────────────────────────────

  async onApplicationBootstrap() {
    const esperandoPago = await this.prisma.turno.findMany({
      where: { estado: 'ESPERANDO_PAGO' },
    });
    for (const turno of esperandoPago) {
      const limite = new Date(
        turno.creadoEn.getTime() + TIMEOUT_PAGO_TURNO_MIN * 60_000,
      );
      if (limite <= new Date()) {
        await this.expirarEsperaPago(turno.id);
      } else {
        this.programar(turno.id, limite, () => this.expirarEsperaPago(turno.id));
      }
    }

    const asignados = await this.prisma.turno.findMany({
      where: { estado: 'ASIGNADO' },
    });
    for (const turno of asignados) {
      const base = turno.asignadoEn ?? turno.creadoEn;
      const limite = new Date(base.getTime() + VENTANA_CONFIRMACION_MIN * 60_000);
      if (limite <= new Date()) {
        await this.expirarVentanaConfirmacion(turno.id);
      } else {
        this.programar(turno.id, limite, () => this.expirarVentanaConfirmacion(turno.id));
      }
    }

    await this.intentarAsignar();
  }

  /**
   * Red de seguridad: reintenta asignar cada 5s. Cubre el caso en que una
   * silla se libera por el timer interno de SesionesService (fin normal de
   * sesión), que no tiene forma de avisarle a este servicio sin crear una
   * dependencia circular. Los disparadores directos (pago aprobado, ventana
   * de confirmación vencida) ya llaman intentarAsignar() al toque; esto es
   * solo el respaldo — 5s de demora es imperceptible frente a la ventana de
   * 2 min que igual tiene el cliente para llegar hasta la silla.
   */
  @Interval(5000)
  private async tick() {
    await this.intentarAsignar().catch((e) =>
      this.logger.error(`Error en tick de asignación: ${e}`),
    );
  }

  // ── Alta: cliente toca "Pagar y esperar mi turno" ─────────────

  async unirse(origin?: string) {
    // Todas las sillas del local cobran lo mismo hoy (asunción de v1): se
    // usa cualquier silla activa como referencia de precio/duración, ya que
    // al anotarse todavía no se sabe qué silla puntual va a tocar.
    const silla = await this.prisma.silla.findFirst({
      where: { estado: { not: 'FUERA_DE_SERVICIO' } },
    });
    if (!silla) {
      throw new NotFoundException('No hay sillas disponibles en este local');
    }

    const externalReference = `turno:${randomUUID()}`;
    const turno = await this.prisma.turno.create({
      data: {
        externalReference,
        monto: silla.precio,
        duracionMin: silla.duracionMin,
      },
    });

    const limite = new Date(Date.now() + TIMEOUT_PAGO_TURNO_MIN * 60_000);
    this.programar(turno.id, limite, () => this.expirarEsperaPago(turno.id));

    const frontendOrigin = (origin ?? this.frontendUrlFallback).replace(/\/+$/, '');
    const notificationUrl = origin
      ? `${frontendOrigin}/api/webhooks/mercadopago`
      : `${this.backendUrlFallback.replace(/\/+$/, '')}/webhooks/mercadopago`;

    try {
      const pref = await this.mp.crearPreferencia({
        titulo: `Turno para silla de masaje — ${turno.duracionMin} min`,
        precio: Number(turno.monto),
        externalReference,
        itemId: turno.id,
        notificationUrl,
        successUrl: `${frontendOrigin}/cola/${turno.id}/exito`,
        failureUrl: `${frontendOrigin}/cola/${turno.id}/fracaso`,
        pendingUrl: `${frontendOrigin}/cola/${turno.id}/fracaso`,
        vigenciaMin: TIMEOUT_PAGO_TURNO_MIN,
      });
      return { turnoId: turno.id, initPoint: pref.initPoint };
    } catch (e) {
      await this.expirarEsperaPago(turno.id);
      throw e;
    }
  }

  // ── ESPERANDO_PAGO → CANCELADA (timeout o cancelación manual) ─

  /**
   * Idempotente: solo actúa si el turno sigue ESPERANDO_PAGO. La reutiliza
   * tanto el timer de 3 min como el endpoint de cancelación manual (cuando
   * el cliente cancela/abandona el checkout de MP), igual patrón que
   * SesionesService.expirarPagoPendiente.
   */
  async expirarEsperaPago(turnoId: string) {
    this.cancelarTimer(turnoId);
    const res = await this.prisma.turno.updateMany({
      where: { id: turnoId, estado: 'ESPERANDO_PAGO' },
      data: { estado: 'CANCELADA', finReal: new Date(), motivoCierre: 'pago_no_recibido' },
    });
    if (res.count > 0) {
      this.logger.log(`Turno ${turnoId} expirado/cancelado sin pago`);
    }
  }

  // ── ESPERANDO_PAGO → EN_COLA (webhook aprobado) ────────────────

  /** Llamado desde PagosService cuando el webhook confirma el pago de un turno. */
  async procesarPagoAprobado(turnoId: string) {
    this.cancelarTimer(turnoId);
    const codigo = await this.generarCodigoUnico();

    const res = await this.prisma.turno.updateMany({
      where: { id: turnoId, estado: 'ESPERANDO_PAGO' },
      data: { estado: 'EN_COLA', pagadoEn: new Date(), codigo },
    });
    if (res.count === 0) {
      this.logger.log(`Turno ${turnoId} ya no estaba ESPERANDO_PAGO, se ignora`);
      return;
    }

    this.logger.log(`Turno ${turnoId}: EN_COLA (código ${codigo})`);
    await this.intentarAsignar();
  }

  private async generarCodigoUnico(): Promise<string> {
    for (let intento = 0; intento < 10; intento++) {
      const candidato = generarCodigo();
      const existe = await this.prisma.turno.findUnique({ where: { codigo: candidato } });
      if (!existe) return candidato;
    }
    throw new Error('No se pudo generar un código de turno único');
  }

  // ── EN_COLA → ASIGNADO (se libera una silla) ───────────────────

  /**
   * Asigna sillas LIBRE a turnos EN_COLA (el más antiguo primero) mientras
   * haya de ambos. Los updates condicionales (`estado: 'LIBRE'` / `estado:
   * 'EN_COLA'`) evitan pisar algo que otra ejecución concurrente (el tick,
   * un pago que se aprueba en simultáneo) ya haya tomado.
   */
  async intentarAsignar() {
    for (let i = 0; i < 50; i++) {
      const turno = await this.prisma.turno.findFirst({
        where: { estado: 'EN_COLA' },
        orderBy: { pagadoEn: 'asc' },
      });
      if (!turno) return;

      const silla = await this.prisma.silla.findFirst({ where: { estado: 'LIBRE' } });
      if (!silla) return;

      const reservada = await this.prisma.silla.updateMany({
        where: { id: silla.id, estado: 'LIBRE' },
        data: { estado: 'RESERVADA' },
      });
      if (reservada.count === 0) continue; // otra ejecución se la ganó, reintentar

      const asignado = await this.prisma.turno.updateMany({
        where: { id: turno.id, estado: 'EN_COLA' },
        data: { estado: 'ASIGNADO', sillaId: silla.id, asignadoEn: new Date() },
      });
      if (asignado.count === 0) {
        // El turno se canceló justo en el medio (ej. timeout de cola, o el
        // cliente lo canceló). Liberamos la silla que acabamos de reservar.
        await this.prisma.silla.updateMany({
          where: { id: silla.id, estado: 'RESERVADA' },
          data: { estado: 'LIBRE' },
        });
        continue;
      }

      const limite = new Date(Date.now() + VENTANA_CONFIRMACION_MIN * 60_000);
      this.programar(turno.id, limite, () => this.expirarVentanaConfirmacion(turno.id));
      this.logger.log(
        `Turno ${turno.id} (${turno.codigo}) asignado a silla ${silla.nombre}, esperando confirmación`,
      );
    }
  }

  // ── ASIGNADO → EN_USO (cliente confirma presencia) ─────────────

  async confirmar(turnoId: string) {
    const turno = await this.prisma.turno.findUnique({ where: { id: turnoId } });
    if (!turno) throw new NotFoundException('Turno no encontrado');
    if (turno.estado !== 'ASIGNADO' || !turno.sillaId) {
      throw new ConflictException(`Turno en estado ${turno.estado}, no se puede confirmar`);
    }

    this.cancelarTimer(turnoId);

    const sesion = await this.prisma.sesion.create({
      data: {
        sillaId: turno.sillaId,
        externalReference: `turno-sesion:${turno.id}`,
        monto: turno.monto,
        duracionMin: turno.duracionMin,
      },
    });

    // Si esto falla (ej. Shelly no responde), el turno queda ASIGNADO sin
    // timer — igual riesgo que ya existe hoy en SesionesService.activarSesion
    // para el pago directo. Requiere intervención manual del admin.
    await this.sesiones.activarSesion(sesion.id);

    await this.prisma.turno.update({
      where: { id: turnoId },
      data: { estado: 'EN_USO', sesionId: sesion.id },
    });

    return { ok: true, sillaId: turno.sillaId };
  }

  // ── ASIGNADO → CANCELADA (no confirmó a tiempo) ────────────────

  private async expirarVentanaConfirmacion(turnoId: string) {
    this.cancelarTimer(turnoId);

    const turno = await this.prisma.turno.findUnique({ where: { id: turnoId } });
    if (!turno || turno.estado !== 'ASIGNADO') return;

    await this.prisma.turno.update({
      where: { id: turnoId },
      data: { estado: 'CANCELADA', finReal: new Date(), motivoCierre: 'no_confirmo_a_tiempo' },
    });

    if (turno.sillaId) {
      await this.prisma.silla.updateMany({
        where: { id: turno.sillaId, estado: 'RESERVADA' },
        data: { estado: 'LIBRE' },
      });
    }

    this.logger.log(`Turno ${turnoId} no confirmó a tiempo, silla liberada`);
    await this.intentarAsignar();
  }

  // ── Consultas públicas ──────────────────────────────────────────

  /** Resumen para mostrar en la landing de una silla ocupada. */
  async estadoResumen() {
    const [enCola, sillasLibres, sillasTotal] = await Promise.all([
      this.prisma.turno.count({ where: { estado: 'EN_COLA' } }),
      this.prisma.silla.count({ where: { estado: 'LIBRE' } }),
      this.prisma.silla.count({ where: { estado: { not: 'FUERA_DE_SERVICIO' } } }),
    ]);
    return { enCola, sillasLibres, sillasTotal };
  }

  /** Estado de un turno puntual, para el polling de /cola/[turnoId]. */
  async estadoTurno(turnoId: string) {
    const turno = await this.prisma.turno.findUnique({
      where: { id: turnoId },
      include: { silla: true },
    });
    if (!turno) throw new NotFoundException('Turno no encontrado');

    let posicion: number | null = null;
    let sillasLibres: number | null = null;
    if (turno.estado === 'EN_COLA' && turno.pagadoEn) {
      [posicion, sillasLibres] = await Promise.all([
        this.prisma.turno.count({
          where: { estado: 'EN_COLA', pagadoEn: { lt: turno.pagadoEn } },
        }),
        this.prisma.silla.count({ where: { estado: 'LIBRE' } }),
      ]);
    }

    let segundosVentana: number | null = null;
    if (turno.estado === 'ASIGNADO' && turno.asignadoEn) {
      const limite = turno.asignadoEn.getTime() + VENTANA_CONFIRMACION_MIN * 60_000;
      segundosVentana = Math.max(0, Math.round((limite - Date.now()) / 1000));
    }

    let segundosRestantesSesion: number | null = null;
    if (turno.estado === 'EN_USO' && turno.silla?.finSesionActual) {
      segundosRestantesSesion = Math.max(
        0,
        Math.round((turno.silla.finSesionActual.getTime() - Date.now()) / 1000),
      );
    }

    return {
      id: turno.id,
      codigo: turno.codigo,
      estado: turno.estado,
      posicion,
      sillasLibres,
      sillaAsignada: turno.silla ? { id: turno.silla.id, nombre: turno.silla.nombre } : null,
      segundosVentana,
      segundosRestantesSesion,
      duracionMin: turno.duracionMin,
    };
  }

  // ── Timers ────────────────────────────────────────────────────

  private programar(turnoId: string, cuando: Date, fn: () => Promise<void>) {
    this.cancelarTimer(turnoId);
    const ms = Math.max(0, cuando.getTime() - Date.now());
    this.timers.set(
      turnoId,
      setTimeout(() => {
        this.timers.delete(turnoId);
        fn().catch((e) => this.logger.error(`Error en timer de turno ${turnoId}: ${e}`));
      }, ms),
    );
  }

  private cancelarTimer(turnoId: string) {
    const t = this.timers.get(turnoId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(turnoId);
    }
  }
}
