import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Interval } from '@nestjs/schedule';
import { IpHashService } from '../common/ip-hash.service';
import { CACHE_TTL_ESTADO_MS } from '../common/cache.config';
import { contarReservasPendientesPorIp } from '../common/reservas-pendientes.util';
import { MAX_PENDIENTES_POR_IP } from '../common/throttle.config';
import { TtlCache } from '../common/ttl-cache';
import { TurnstileService } from '../common/turnstile.service';
import { CreditosService } from '../creditos/creditos.service';
import { FallosCanjeService } from '../creditos/fallos-canje.service';
import { MercadoPagoService } from '../mercadopago/mercadopago.service';
import { PrismaService } from '../prisma/prisma.service';
import { SesionesService, tiemposDeSilla } from '../sesiones/sesiones.service';
import { HeartbeatService } from '../shelly/heartbeat.service';
import { SillasService } from '../sillas/sillas.service';
import { generarCodigo } from './codigo.util';

/** Minutos que se espera el pago de un turno antes de cancelarlo. */
export const TIMEOUT_PAGO_TURNO_MIN = 3;
/** Minutos de ventana para confirmar presencia una vez asignada una silla. */
export const VENTANA_CONFIRMACION_MIN = 2;

/** Resumen que cachea `estadoResumen()` (Bloque C): sin campos de reloj en
 * vivo, se cachea el objeto completo tal cual se devuelve. */
type ResumenCola = { enCola: number; sillasLibres: number; sillasTotal: number };

/** Fila de `turno` (con sus includes) que cachea `estadoTurno()` (Bloque C). */
type TurnoConIncludes = Prisma.TurnoGetPayload<{
  include: {
    silla: true;
    sesion: { select: { id: true; estado: true; interrumpidaEn: true } };
  };
}>;

/** Key fija del único resumen cacheado (no hay uno por silla ni por local). */
const KEY_RESUMEN = 'resumen';

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
  private readonly frontendUrlFallback: string;

  /**
   * Caches de estado público (Bloque C). Se cachean filas/resultados
   * crudos, nunca la respuesta final: `segundosVentana` y
   * `segundosRestantesSesion` de `estadoTurno` dependen de `Date.now()` y se
   * recalculan en cada llamada, incluso en un hit de cache.
   */
  private readonly resumenCache = new TtlCache<ResumenCola>(CACHE_TTL_ESTADO_MS);
  private readonly turnoCache = new TtlCache<TurnoConIncludes | null>(CACHE_TTL_ESTADO_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mp: MercadoPagoService,
    private readonly sesiones: SesionesService,
    private readonly heartbeat: HeartbeatService,
    private readonly creditos: CreditosService,
    private readonly fallosCanje: FallosCanjeService,
    private readonly turnstile: TurnstileService,
    private readonly ipHash: IpHashService,
    private readonly sillas: SillasService,
    config: ConfigService,
  ) {
    this.frontendUrlFallback = config.get<string>('FRONTEND_URL', '');
  }

  /** Fuerza a que el próximo `estadoResumen()` vuelva a pegarle a la base. */
  invalidarCacheResumen(): void {
    this.resumenCache.invalidar(KEY_RESUMEN);
  }

  /** Fuerza a que el próximo `estadoTurno(turnoId)` vuelva a pegarle a la base. */
  invalidarCacheTurno(turnoId: string): void {
    this.turnoCache.invalidar(turnoId);
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

  async unirse(
    origin: string | undefined,
    turnstileToken: string | undefined,
    ipCliente: string,
  ) {
    // Todas las sillas del local cobran lo mismo hoy (asunción de v1): se
    // usa cualquier silla activa como referencia de precio/duración, ya que
    // al anotarse todavía no se sabe qué silla puntual va a tocar.
    const sillas = await this.prisma.silla.findMany({
      where: { estado: { not: 'FUERA_DE_SERVICIO' } },
    });
    if (sillas.length === 0) {
      throw new NotFoundException('No hay sillas disponibles en este local');
    }
    // Si el local está sin luz no hay turno que valga: mejor no cobrarlo.
    const conEnergia = sillas.filter((s) => !this.heartbeat.estaOffline(s.id));
    if (conEnergia.length === 0) {
      throw new ConflictException(
        'Las sillas están sin conexión en este momento. Probá en unos minutos.',
      );
    }
    const silla = conEnergia[0];

    const verificacion = await this.turnstile.verificar(turnstileToken, ipCliente);
    if (!verificacion.ok) {
      throw new ForbiddenException(
        'No pudimos verificar que sos una persona real. Volvé a intentar.',
      );
    }

    const ipHash = this.ipHash.hash(ipCliente);
    // El chequeo del tope y la creación del turno van en UNA transacción con
    // un advisory lock por ip_hash: sin eso, N pedidos simultáneos de la misma
    // IP pasan todos el count() antes de que exista el primer turno y
    // esquivan MAX_PENDIENTES_POR_IP. El lock se libera solo al terminar la
    // transacción y solo serializa pedidos de la MISMA IP.
    const turno = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ipHash}))`;
      const pendientes = await contarReservasPendientesPorIp(tx as any, ipHash);
      if (pendientes >= MAX_PENDIENTES_POR_IP) {
        throw new HttpException(
          'Ya tenés varias reservas esperando pago. Esperá a que se confirmen ' +
            'o venzan antes de intentar de nuevo.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return tx.turno.create({
        data: {
          externalReference: `turno:${randomUUID()}`,
          monto: silla.precio,
          duracionMin: silla.duracionMin,
          ipHash,
        },
      });
    });
    const externalReference = turno.externalReference;

    const limite = new Date(Date.now() + TIMEOUT_PAGO_TURNO_MIN * 60_000);
    this.programar(turno.id, limite, () => this.expirarEsperaPago(turno.id));

    const frontendOrigin = (origin ?? this.frontendUrlFallback).replace(/\/+$/, '');

    try {
      const pref = await this.mp.crearPreferencia({
        titulo: `Turno para silla de masaje — ${turno.duracionMin} min`,
        precio: Number(turno.monto),
        externalReference,
        itemId: turno.id,
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
      this.invalidarCacheTurno(turnoId);
      this.logger.log(`Turno ${turnoId} expirado/cancelado sin pago`);
    }
  }

  // ── ESPERANDO_PAGO → EN_COLA (webhook aprobado) ────────────────

  /**
   * Llamado desde PagosService cuando el webhook confirma el pago de un
   * turno. Tira ConflictException si el turno ya no está ESPERANDO_PAGO
   * (venció o se canceló antes de que llegara el pago) — PagosService lo
   * atrapa para marcar el pago con requiereRevision=true, mismo contrato
   * que SesionesService.activarSesion para el flujo de sesión directa.
   */
  async procesarPagoAprobado(turnoId: string) {
    this.cancelarTimer(turnoId);
    const codigo = await this.generarCodigoUnico();

    const res = await this.prisma.turno.updateMany({
      where: { id: turnoId, estado: 'ESPERANDO_PAGO' },
      data: { estado: 'EN_COLA', pagadoEn: new Date(), codigo },
    });
    if (res.count === 0) {
      // El turno ya no estaba ESPERANDO_PAGO (venció o se canceló antes de
      // que llegara este pago aprobado). Igual que
      // SesionesService.activarSesion en el caso análogo, se tira
      // ConflictException: es lo que PagosService.procesarPagoDeTurno
      // atrapa para marcar el pago con requiereRevision=true en vez de
      // perder de vista una plata cobrada sin turno detrás.
      throw new ConflictException(`Turno ${turnoId} ya no estaba ESPERANDO_PAGO`);
    }
    this.invalidarCacheTurno(turnoId);
    this.invalidarCacheResumen(); // enCola sube

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

      // Una silla sin energía está libre en la base pero no puede encender:
      // asignarla le quemaría al cliente su ventana de 2 minutos.
      const libres = await this.prisma.silla.findMany({ where: { estado: 'LIBRE' } });
      const silla = libres.find((l) => !this.heartbeat.estaOffline(l.id));
      if (!silla) return;

      const reservada = await this.prisma.silla.updateMany({
        where: { id: silla.id, estado: 'LIBRE' },
        data: { estado: 'RESERVADA' },
      });
      if (reservada.count === 0) continue; // otra ejecución se la ganó, reintentar
      this.sillas.invalidarCache(silla.id);
      this.invalidarCacheResumen(); // sillasLibres baja

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
        this.sillas.invalidarCache(silla.id);
        this.invalidarCacheResumen(); // sillasLibres vuelve a subir
        continue;
      }
      this.invalidarCacheTurno(turno.id);
      this.invalidarCacheResumen(); // enCola baja

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

    // Los tiempos propios de la masajeadora (gracia de inicio, retorno) son
    // de la silla asignada, no del turno.
    const silla = await this.prisma.silla.findUnique({ where: { id: turno.sillaId } });

    const sesion = await this.prisma.sesion.create({
      data: {
        sillaId: turno.sillaId,
        externalReference: `turno-sesion:${turno.id}`,
        monto: turno.monto,
        duracionMin: turno.duracionMin,
        ...(silla ? tiemposDeSilla(silla) : {}),
      },
    });

    // Si esto falla (ej. Shelly no responde), el turno queda ASIGNADO sin
    // timer — igual riesgo que ya existe hoy en SesionesService.activarSesion
    // para el pago directo. Requiere intervención manual del admin.
    // (activarSesion ya invalida la cache de SillasService de esta silla.)
    await this.sesiones.activarSesion(sesion.id);

    await this.prisma.turno.update({
      where: { id: turnoId },
      data: { estado: 'EN_USO', sesionId: sesion.id },
    });
    this.invalidarCacheTurno(turnoId);
    // La silla pasa de RESERVADA a EN_USO, no de/a LIBRE: no cambia
    // sillasLibres/sillasTotal, así que el resumen no necesita invalidarse.

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
    this.invalidarCacheTurno(turnoId);

    if (turno.sillaId) {
      await this.prisma.silla.updateMany({
        where: { id: turno.sillaId, estado: 'RESERVADA' },
        data: { estado: 'LIBRE' },
      });
      this.sillas.invalidarCache(turno.sillaId);
      this.invalidarCacheResumen(); // sillasLibres sube
    }

    this.logger.log(`Turno ${turnoId} no confirmó a tiempo, silla liberada`);
    await this.intentarAsignar();
  }

  // ── Consultas públicas ──────────────────────────────────────────

  /**
   * Resumen para mostrar en la landing de una silla ocupada. Sin campos de
   * reloj en vivo (Bloque C): se cachea el objeto completo tal cual, no hay
   * nada que recalcular en un hit de cache.
   */
  async estadoResumen(): Promise<ResumenCola> {
    return this.resumenCache.obtenerOCargar(KEY_RESUMEN, async () => {
      const [enCola, sillasLibres, sillasTotal] = await Promise.all([
        this.prisma.turno.count({ where: { estado: 'EN_COLA' } }),
        this.prisma.silla.count({ where: { estado: 'LIBRE' } }),
        this.prisma.silla.count({ where: { estado: { not: 'FUERA_DE_SERVICIO' } } }),
      ]);
      return { enCola, sillasLibres, sillasTotal };
    });
  }

  /** Segundos que faltan para que termine la sesión en curso más próxima a vencer. */
  private async segundosHastaProximaSilla(): Promise<number | null> {
    try {
      const silla = await this.prisma.silla.findFirst({
        where: { estado: 'EN_USO', finSesionActual: { not: null } },
        orderBy: { finSesionActual: 'asc' },
        select: { finSesionActual: true },
      });
      if (!silla?.finSesionActual) return null;
      return Math.max(0, Math.round((silla.finSesionActual.getTime() - Date.now()) / 1000));
    } catch {
      // Dato informativo: si falla no debe romper el polling del turno.
      return null;
    }
  }

  /**
   * Estado de un turno puntual, para el polling de /cola/[turnoId].
   *
   * Bloque C: se cachea la fila cruda de `turno` (con sus includes);
   * `segundosVentana` y `segundosRestantesSesion` se recalculan siempre en
   * vivo. `posicion`/`sillasLibres` (el conteo de la cola en el momento) se
   * dejan siempre en vivo a propósito: son dos `count()` baratos sobre
   * columnas indexadas y cambian tan rápido — cualquier pago aprobado o
   * asignación en curso las mueve — que cachearlas ni ahorra demasiado ni
   * conviene: es justo lo que el cliente está mirando bajar en pantalla.
   * `credito` tampoco se cachea, mismo motivo que en
   * SesionesService.estadoPublico.
   */
  async estadoTurno(turnoId: string) {
    const turno = await this.turnoCache.obtenerOCargar(turnoId, () =>
      this.prisma.turno.findUnique({
        where: { id: turnoId },
        include: {
          silla: true,
          sesion: { select: { id: true, estado: true, interrumpidaEn: true } },
        },
      }),
    );
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

    // Para quien espera: cuánto falta para que termine la sesión en curso
    // más cercana a vencer (la próxima silla en liberarse). Sirve para que el
    // cliente vea cómo va la cola. Solo tiene sentido si no hay sillas libres.
    let segundosProximaSilla: number | null = null;
    if (turno.estado === 'EN_COLA' && sillasLibres === 0) {
      segundosProximaSilla = await this.segundosHastaProximaSilla();
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

    // Si el turno se cayó por un corte de energía, el cliente tiene un vale
    // esperándolo: se lo mostramos acá, que es la pantalla que ya tiene abierta.
    const credito = turno.sesionId
      ? await this.creditos.porSesion(turno.sesionId)
      : null;

    return {
      id: turno.id,
      codigo: turno.codigo,
      estado: turno.estado,
      posicion,
      sillasLibres,
      sillaAsignada: turno.silla ? { id: turno.silla.id, nombre: turno.silla.nombre } : null,
      segundosVentana,
      segundosRestantesSesion,
      segundosProximaSilla,
      duracionMin: turno.duracionMin,
      sesionEstado: turno.sesion?.estado ?? null,
      interrumpida: turno.sesion?.interrumpidaEn != null,
      motivoCierre: turno.motivoCierre,
      credito: credito
        ? {
            codigo: credito.codigo,
            duracionMin: credito.duracionMin,
            estado: credito.estado,
            venceEn: credito.venceEn,
          }
        : null,
    };
  }

  // ── Canje de créditos ──────────────────────────────────────────

  /**
   * El cliente ingresa el código de un vale y vuelve a la cola sin pagar de
   * nuevo. Entra con la antigüedad que ya tenía (`prioridadDesde`), no al
   * final de la fila: el corte de luz no fue culpa suya.
   *
   * El canje es la confirmación de que sigue en el local — por eso no le
   * preguntamos nada antes de emitir el vale: si se fue, simplemente no lo
   * canjea y el vale vence solo.
   */
  async canjearCredito(codigoIngresado: string, ipCliente: string) {
    this.fallosCanje.verificarNoBloqueado(ipCliente);

    let credito;
    try {
      credito = await this.creditos.tomar(codigoIngresado);
    } catch (e) {
      this.fallosCanje.registrarFallo(ipCliente);
      throw e;
    }
    this.fallosCanje.registrarExito(ipCliente);

    const codigo = await this.generarCodigoUnico();
    let turno;
    try {
      turno = await this.prisma.turno.create({
        data: {
          externalReference: `credito:${credito.id}`,
          monto: 0,
          duracionMin: credito.duracionMin,
          estado: 'EN_COLA',
          codigo,
          pagadoEn: credito.prioridadDesde,
        },
      });
    } catch (e) {
      // No dejamos el vale quemado por un error nuestro.
      await this.prisma.credito.updateMany({
        where: { id: credito.id, estado: 'CANJEADO' },
        data: { estado: 'DISPONIBLE', canjeadoEn: null },
      });
      throw e;
    }
    this.invalidarCacheResumen(); // el turno nace directo en EN_COLA

    await this.creditos.vincularTurno(credito.id, turno.id);
    this.logger.log(
      `Crédito ${credito.codigo} canjeado → turno ${turno.id} (${codigo}), ` +
        `${credito.duracionMin} min`,
    );
    await this.intentarAsignar();
    return { turnoId: turno.id, codigo, duracionMin: turno.duracionMin };
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
