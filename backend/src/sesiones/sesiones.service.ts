import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Credito, Prisma, Silla } from '@prisma/client';
import { CACHE_TTL_ESTADO_MS } from '../common/cache.config';
import { TtlCache } from '../common/ttl-cache';
import { CreditosService } from '../creditos/creditos.service';
import { PrismaService } from '../prisma/prisma.service';
import { HeartbeatService } from '../shelly/heartbeat.service';
import { ShellyService } from '../shelly/shelly.service';
import { SillasService } from '../sillas/sillas.service';
import { calcularReloj } from './reloj.util';

/** Minutos que se reserva la silla mientras el cliente paga. */
export const TIMEOUT_PAGO_MIN = 3;

/**
 * Colchón del auto-off que se programa en la nube de Shelly (`toggle_after`)
 * por encima de la duración de la sesión. El apagado normal lo manda el
 * backend al vencer el timer; esto solo actúa si eso no llega a pasar.
 *
 * Ojo: ese timer vive DENTRO del equipo, así que un corte de luz lo borra.
 * Por eso al reanudar tras un corte hay que volver a programarlo.
 */
export const MARGEN_AUTO_OFF_SEG = 60;

/**
 * Corte de energía que se tolera dentro de una sesión en curso: se le
 * devuelve al cliente el tiempo caído y sigue donde estaba. Si el corte dura
 * más que esto, la sesión se cierra y se emite un crédito canjeable — no
 * tiene sentido encender una silla vacía diez minutos después.
 */
export const UMBRAL_CORTE_SEG = 5 * 60;

/**
 * Segundos extra que se regalan por cada corte, además del tiempo caído: la
 * masajeadora vuelve en standby y el cliente tiene que arrancar el programa
 * de nuevo. Errar para el lado de regalar unos segundos sale barato y evita
 * la discusión.
 */
export const GRACIA_REINICIO_SEG = 30;

/**
 * Si al momento del corte quedaba menos que esto, la sesión se da por
 * cumplida en vez de emitir un crédito: un corte a los 9:50 de 10 minutos
 * no es un turno perdido.
 */
export const RESTO_DESPRECIABLE_SEG = 60;

/**
 * Cuánto se espera a que vuelva la luz cuando el pago ya entró pero la silla
 * nunca llegó a encenderse. Pasado esto el pago se convierte en crédito.
 */
export const MAX_ESPERA_ENERGIA_SEG = 10 * 60;

/**
 * Minutos que tiene el cliente, una vez aprobado el pago, para sentarse y
 * tocar "Ya estoy, confirmar" antes de que la silla se encienda. Mismo valor
 * que la ventana de la cola (VENTANA_CONFIRMACION_MIN en ColaService, que no
 * se puede importar acá sin crear un ciclo de módulos).
 */
export const VENTANA_CONFIRMACION_SESION_MIN = 2;

/**
 * Valores por defecto de los tiempos propios de la masajeadora (ver
 * reloj.util.ts). Cada silla tiene los suyos, editables desde el panel.
 */
export const GRACIA_INICIO_SEG_DEFAULT = 30;
export const PAUSA_RETORNO_SEG_DEFAULT = 10;
export const RETORNO_SEG_DEFAULT = 40;

/**
 * Tiempos de una silla o sesión, con los defaults si faltan. Faltan cuando el
 * cliente de Prisma quedó desactualizado respecto del schema (no se corrió
 * `prisma generate`): sin esto, `undefined * 1000` da NaN y Prisma rechaza
 * la fecha inválida en pleno cierre de sesión.
 */
export function tiemposDeSilla(silla: {
  graciaInicioSeg?: number | null;
  pausaRetornoSeg?: number | null;
  retornoSeg?: number | null;
}) {
  return {
    graciaInicioSeg: silla.graciaInicioSeg ?? GRACIA_INICIO_SEG_DEFAULT,
    pausaRetornoSeg: silla.pausaRetornoSeg ?? PAUSA_RETORNO_SEG_DEFAULT,
    retornoSeg: silla.retornoSeg ?? RETORNO_SEG_DEFAULT,
  };
}

/** Fila de `sesion` tal como la cachea `estadoPublico` (Bloque C): incluye
 * el `silla` mínimo que necesita la respuesta, nada más. */
type SesionConSilla = Prisma.SesionGetPayload<{
  include: { silla: { select: { id: true; nombre: true } } };
}>;

/**
 * Máquina de estados de la silla:
 *
 *   LIBRE → PAGO_PENDIENTE → EN_USO ──────────────────────→ LIBRE
 *            (timeout 3min)   (gracia + duracionMin, luego
 *                              sesión SALIDA: pausa + retorno)
 *
 * Con energía de por medio hay dos desvíos, que dispara EnergiaService:
 *   - el pago entra pero el Shelly no responde  → sesión ESPERANDO_ENERGIA
 *   - se corta la luz con la sesión andando     → sesión ACTIVA + interrumpidaEn
 *
 * Este servicio es el ÚNICO que transiciona estados y maneja timers.
 * Al reiniciar el servidor, reconstruye los timers desde la DB.
 */
@Injectable()
export class SesionesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SesionesService.name);
  private timers = new Map<string, NodeJS.Timeout>();

  /**
   * Cache de estado público (Bloque C), keyed por sesionId. Se cachea la
   * fila cruda (con el `silla` mínimo incluido), nunca la respuesta final:
   * `segundosRestantes` depende de `Date.now()` y se recalcula en cada
   * llamada a `estadoPublico`, incluso en un hit de cache.
   */
  private readonly cache = new TtlCache<SesionConSilla | null>(CACHE_TTL_ESTADO_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shelly: ShellyService,
    private readonly heartbeat: HeartbeatService,
    private readonly creditos: CreditosService,
    private readonly sillas: SillasService,
  ) {}

  /**
   * Fuerza a que el próximo `estadoPublico(sesionId)` vuelva a pegarle a la
   * base. Se llama después de cualquier escritura que cambie `estado`,
   * `finProgramado`, `interrumpidaEn`, `cortes`, `segundosCompensados` o
   * `motivoCierre` de esta sesión.
   */
  invalidarCache(sesionId: string): void {
    this.cache.invalidar(sesionId);
  }

  // ── Recuperación tras reinicio ────────────────────────────────

  async onApplicationBootstrap() {
    // Sesiones activas: reprogramar apagado (o apagar ya si venció)
    const activas = await this.prisma.sesion.findMany({
      where: { estado: 'ACTIVA' },
    });
    for (const sesion of activas) {
      if (sesion.interrumpidaEn) {
        // Corte en curso cuando se reinició el backend: no tocamos nada acá,
        // EnergiaService decide (reanudar o crédito) con el próximo heartbeat.
        this.logger.warn(
          `Sesión ${sesion.id} quedó con un corte en curso desde ${sesion.interrumpidaEn.toISOString()}`,
        );
        continue;
      }
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

    // Sesiones en la fase de salida (pausa + pulso de retorno)
    const enSalida = await this.prisma.sesion.findMany({
      where: { estado: 'SALIDA' },
    });
    for (const sesion of enSalida) {
      const fin = sesion.salidaHasta ?? new Date();
      const inicioRetorno = new Date(fin.getTime() - tiemposDeSilla(sesion).retornoSeg * 1000);
      if (fin <= new Date()) {
        await this.cerrarSalida(sesion.id);
      } else if (inicioRetorno > new Date()) {
        // Todavía en la pausa: el pulso de retorno no se mandó.
        this.programar(sesion.id, inicioRetorno, () => this.iniciarRetorno(sesion.id));
      } else {
        // El pulso ya está corriendo (y su `toggle_after` vive en el equipo):
        // solo falta cerrar.
        this.programar(sesion.id, fin, () => this.cerrarSalida(sesion.id));
      }
    }

    // Sesiones pagadas esperando que vuelva la luz
    const esperandoEnergia = await this.prisma.sesion.findMany({
      where: { estado: 'ESPERANDO_ENERGIA' },
    });
    for (const sesion of esperandoEnergia) {
      const limite = new Date(
        (sesion.pagadaEn ?? sesion.creadaEn).getTime() + MAX_ESPERA_ENERGIA_SEG * 1000,
      );
      if (limite <= new Date()) {
        await this.vencerEsperaEnergia(sesion.id);
      } else {
        this.programar(sesion.id, limite, () => this.vencerEsperaEnergia(sesion.id));
      }
    }

    // Sesiones pagadas esperando que el cliente confirme que se sentó
    const esperandoConfirmacion = await this.prisma.sesion.findMany({
      where: { estado: 'ESPERANDO_CONFIRMACION' },
    });
    for (const sesion of esperandoConfirmacion) {
      const limite = new Date(
        (sesion.pagadaEn ?? sesion.creadaEn).getTime() +
          VENTANA_CONFIRMACION_SESION_MIN * 60_000,
      );
      if (limite <= new Date()) {
        await this.expirarConfirmacion(sesion.id);
      } else {
        this.programar(sesion.id, limite, () => this.expirarConfirmacion(sesion.id));
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
  async crearSesionPendiente(
    silla: Silla,
    externalReference: string,
    ipHash: string | null = null,
  ) {
    // Antes que nada: no cobramos lo que no podemos entregar. Si el Shelly
    // no responde (corte en el local, WiFi caído), el cliente ni llega al
    // checkout — es mucho más barato que devolverle la plata después.
    if (this.heartbeat.estaOffline(silla.id)) {
      throw new ConflictException(
        'El sillón está sin conexión en este momento. Probá en unos minutos.',
      );
    }

    const reservada = await this.prisma.silla.updateMany({
      where: { id: silla.id, estado: 'LIBRE' },
      data: { estado: 'PAGO_PENDIENTE' },
    });
    if (reservada.count === 0) {
      throw new ConflictException('El sillón no está libre en este momento');
    }
    this.sillas.invalidarCache(silla.id);

    const sesion = await this.prisma.sesion.create({
      data: {
        sillaId: silla.id,
        externalReference,
        monto: silla.precio,
        duracionMin: silla.duracionMin,
        ...tiemposDeSilla(silla),
        ipHash: ipHash ?? undefined,
      },
    });

    const limite = new Date(Date.now() + TIMEOUT_PAGO_MIN * 60_000);
    this.programar(sesion.id, limite, () => this.expirarPagoPendiente(sesion.id));
    this.logger.log(`Silla ${silla.nombre}: PAGO_PENDIENTE (sesión ${sesion.id})`);
    return sesion;
  }

  // ── PAGO_PENDIENTE → ESPERANDO_CONFIRMACION ──────────────────

  /**
   * Pago aprobado por el flujo directo (silla libre): en vez de encender la
   * silla al toque —y que el reloj corra con el cliente todavía caminando—,
   * se la deja reservada unos minutos hasta que confirme que se sentó
   * (`confirmarSesion`). Si no confirma, `expirarConfirmacion` la libera.
   *
   * Mismo contrato que `activarSesion` para PagosService: idempotente si ya
   * pasó por acá, y ConflictException si la sesión ya no estaba PENDIENTE
   * (venció el pago, se canceló) para que el pago quede marcado a revisión.
   */
  async esperarConfirmacion(sesionId: string) {
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion) throw new NotFoundException('Sesión no encontrada');
    if (sesion.estado === 'ESPERANDO_CONFIRMACION' || sesion.estado === 'ACTIVA') {
      return sesion; // idempotente (webhook + retorno de MP)
    }
    if (sesion.estado !== 'PENDIENTE') {
      throw new ConflictException(`Sesión en estado ${sesion.estado}, no confirmable`);
    }

    this.cancelarTimer(sesionId); // cancela la expiración por falta de pago

    const pagadaEn = new Date();
    const reclamada = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'PENDIENTE' },
      data: { estado: 'ESPERANDO_CONFIRMACION', pagadaEn },
    });
    if (reclamada.count === 0) {
      throw new ConflictException(`Sesión ${sesionId} ya no estaba PENDIENTE`);
    }
    await this.prisma.silla.updateMany({
      where: { id: sesion.sillaId, estado: 'PAGO_PENDIENTE' },
      data: { estado: 'RESERVADA' },
    });
    this.invalidarCache(sesionId);
    this.sillas.invalidarCache(sesion.sillaId);

    const limite = new Date(pagadaEn.getTime() + VENTANA_CONFIRMACION_SESION_MIN * 60_000);
    this.programar(sesionId, limite, () => this.expirarConfirmacion(sesionId));
    this.logger.log(
      `Silla ${sesion.silla.nombre}: RESERVADA, esperando que el cliente confirme (sesión ${sesionId})`,
    );
    return this.prisma.sesion.findUnique({ where: { id: sesionId } });
  }

  /** ESPERANDO_CONFIRMACION → ACTIVA: el cliente confirmó que se sentó. */
  async confirmarSesion(sesionId: string) {
    const sesion = await this.prisma.sesion.findUnique({ where: { id: sesionId } });
    if (!sesion) throw new NotFoundException('Sesión no encontrada');
    if (sesion.estado === 'ACTIVA') return { ok: true, sillaId: sesion.sillaId }; // doble toque
    if (sesion.estado !== 'ESPERANDO_CONFIRMACION') {
      throw new ConflictException(`Sesión en estado ${sesion.estado}, no se puede confirmar`);
    }
    await this.activarSesion(sesionId);
    return { ok: true, sillaId: sesion.sillaId };
  }

  /** ESPERANDO_CONFIRMACION → CANCELADA: no se sentó a tiempo, se libera la silla. */
  async expirarConfirmacion(sesionId: string) {
    this.cancelarTimer(sesionId);

    const expirada = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'ESPERANDO_CONFIRMACION' },
      data: { estado: 'CANCELADA', finReal: new Date(), motivoCierre: 'no_confirmo_a_tiempo' },
    });
    if (expirada.count === 0) return;
    this.invalidarCache(sesionId);

    const sesion = await this.prisma.sesion.findUnique({ where: { id: sesionId } });
    if (sesion) {
      await this.prisma.silla.updateMany({
        where: { id: sesion.sillaId, estado: 'RESERVADA' },
        data: { estado: 'LIBRE' },
      });
      this.sillas.invalidarCache(sesion.sillaId);
    }
    this.logger.log(`Sesión ${sesionId} no confirmó a tiempo, silla liberada`);
  }

  // ── PAGO_PENDIENTE → EN_USO ───────────────────────────────────

  /**
   * Activa la sesión: enciende el relé y programa el apagado.
   *
   * Si el Shelly no responde NO se pierde el pago: la sesión pasa a
   * ESPERANDO_ENERGIA y EnergiaService reintenta cada 15 s hasta que vuelva
   * la luz (o hasta MAX_ESPERA_ENERGIA_SEG, y ahí se convierte en crédito).
   * Es idempotente y se puede volver a llamar sobre una ESPERANDO_ENERGIA.
   */
  async activarSesion(sesionId: string) {
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion) throw new NotFoundException('Sesión no encontrada');
    if (sesion.estado === 'ACTIVA') return sesion; // idempotente
    if (
      sesion.estado !== 'PENDIENTE' &&
      sesion.estado !== 'ESPERANDO_ENERGIA' &&
      sesion.estado !== 'ESPERANDO_CONFIRMACION'
    ) {
      throw new ConflictException(`Sesión en estado ${sesion.estado}, no activable`);
    }

    this.cancelarTimer(sesionId); // cancela la expiración de pago / de espera

    // Para una sesión pagada, el reloj de "cuánto hace que cobramos sin
    // entregar" arranca en el primer intento, no en el último.
    const pagadaEn = sesion.esManual ? null : (sesion.pagadaEn ?? new Date());

    // El relé queda encendido la duración contratada MÁS la gracia de inicio
    // (tiempo para sentarse y presionar START). El cliente no ve la gracia:
    // su reloj queda en la duración completa hasta que termina (reloj.util).
    const segundosRele = sesion.duracionMin * 60 + tiemposDeSilla(sesion).graciaInicioSeg;

    // Primero el relé: si Shelly falla, no cobramos tiempo que no corre.
    // `toggle_after` deja programado el apagado en la nube de Shelly: si el
    // backend se cae antes de mandar el OFF, el relé se corta igual.
    try {
      await this.shelly.setRele(
        sesion.silla.deviceIdShelly,
        true,
        segundosRele + MARGEN_AUTO_OFF_SEG,
      );
    } catch (e) {
      return this.marcarEsperandoEnergia(sesion.id, sesion.silla.nombre, pagadaEn, e);
    }

    // El reloj del cliente arranca cuando el relé ya cerró, no cuando lo
    // pedimos: la ida y vuelta con Shelly Cloud puede llevarse un segundo.
    const inicio = new Date();
    const finProgramado = new Date(inicio.getTime() + segundosRele * 1000);

    const [actualizada] = await this.prisma.$transaction([
      this.prisma.sesion.update({
        where: { id: sesionId },
        data: {
          estado: 'ACTIVA',
          inicio,
          finProgramado,
          pagadaEn: pagadaEn ?? undefined,
          interrumpidaEn: null,
        },
      }),
      this.prisma.silla.update({
        where: { id: sesion.sillaId },
        data: { estado: 'EN_USO', finSesionActual: finProgramado },
      }),
    ]);
    this.invalidarCache(sesionId);
    this.sillas.invalidarCache(sesion.sillaId);

    this.programar(sesionId, finProgramado, () =>
      this.finalizarSesion(sesionId, 'tiempo_cumplido'),
    );
    this.logger.log(
      `Silla ${sesion.silla.nombre}: EN_USO hasta ${finProgramado.toISOString()}`,
    );
    return actualizada;
  }

  /**
   * El pago entró pero el relé no contesta. La silla queda reservada (no
   * vuelve a LIBRE) para que nadie más la pague, y el cliente ve en pantalla
   * que estamos esperando que vuelva la luz.
   */
  private async marcarEsperandoEnergia(
    sesionId: string,
    nombreSilla: string,
    pagadaEn: Date | null,
    error: unknown,
  ) {
    const actualizada = await this.prisma.sesion.update({
      where: { id: sesionId },
      data: { estado: 'ESPERANDO_ENERGIA', pagadaEn: pagadaEn ?? undefined },
    });
    this.invalidarCache(sesionId);

    const desde = pagadaEn ?? actualizada.creadaEn;
    const limite = new Date(desde.getTime() + MAX_ESPERA_ENERGIA_SEG * 1000);
    this.programar(sesionId, limite, () => this.vencerEsperaEnergia(sesionId));

    this.logger.error(
      `Silla ${nombreSilla}: pago cobrado pero el relé no responde. ` +
        `Sesión ${sesionId} en ESPERANDO_ENERGIA, se reintenta hasta ` +
        `${limite.toISOString()}. ${error}`,
    );
    return actualizada;
  }

  /** Se acabó la paciencia: el pago no se pudo prestar, se convierte en crédito. */
  async vencerEsperaEnergia(sesionId: string): Promise<Credito | null> {
    this.cancelarTimer(sesionId);
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion || sesion.estado !== 'ESPERANDO_ENERGIA') return null;

    const cerrada = await this.cerrarYLiberar(sesion.id, sesion.sillaId, {
      estado: 'CANCELADA',
      motivo: 'sin_energia_al_pagar',
      estadoTurno: 'CANCELADA',
      desde: ['ESPERANDO_ENERGIA'],
    });
    if (!cerrada) return null; // otra pasada ya la cerró

    const credito = await this.emitirCreditoDe(sesion.id, {
      duracionMin: sesion.duracionMin,
      esManual: sesion.esManual,
      motivo: 'sin_energia_al_pagar',
      prioridadDesde: sesion.pagadaEn ?? sesion.creadaEn,
    });
    this.logger.warn(
      `Sesión ${sesion.id} nunca pudo encender la silla ${sesion.silla.nombre}` +
        (credito ? `, se emitió el crédito ${credito.codigo}` : ''),
    );
    return credito;
  }

  // ── Cortes de energía con la sesión andando ───────────────────

  /**
   * Marca que la sesión quedó a oscuras. Idempotente: si ya había un corte
   * en curso no vuelve a contarlo.
   *
   * `detectadoEn` es el momento de la LECTURA que vio el equipo caído (no
   * `now`), así el tiempo que se devuelve no depende de cada cuánto corra el
   * chequeo.
   */
  async registrarCorte(sesionId: string, detectadoEn: Date): Promise<boolean> {
    const res = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'ACTIVA', interrumpidaEn: null },
      data: { interrumpidaEn: detectadoEn, cortes: { increment: 1 } },
    });
    if (res.count === 0) return false;
    this.invalidarCache(sesionId);
    this.logger.warn(
      `Sesión ${sesionId}: corte de energía detectado a las ${detectadoEn.toISOString()}`,
    );
    return true;
  }

  /**
   * Volvió la luz dentro del umbral: se le devuelve al cliente el tiempo
   * caído (más la gracia de reinicio) y la sesión sigue.
   *
   * Hay que volver a mandar el ON sí o sí: el Shelly rebootea con el relé
   * abierto y perdió el `toggle_after` que tenía programado.
   */
  async reanudarTrasCorte(sesionId: string): Promise<boolean> {
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (
      !sesion ||
      sesion.estado !== 'ACTIVA' ||
      !sesion.interrumpidaEn ||
      !sesion.finProgramado
    ) {
      return false;
    }

    const caidoSeg = Math.max(
      0,
      Math.round((Date.now() - sesion.interrumpidaEn.getTime()) / 1000),
    );
    const devolver = caidoSeg + GRACIA_REINICIO_SEG;
    const nuevoFin = new Date(sesion.finProgramado.getTime() + devolver * 1000);
    const restanteSeg = Math.max(
      1,
      Math.round((nuevoFin.getTime() - Date.now()) / 1000),
    );

    // Si esto falla, dejamos `interrumpidaEn` como está: el próximo tick de
    // EnergiaService reintenta y el tiempo caído sigue corriendo a favor del
    // cliente.
    await this.shelly.setRele(
      sesion.silla.deviceIdShelly,
      true,
      restanteSeg + MARGEN_AUTO_OFF_SEG,
    );

    // Reclamo condicional: si otra pasada ya reanudó esta sesión, el update
    // no matchea y salimos sin volver a devolverle el tiempo al cliente. El
    // ON de arriba, en ese caso, fue redundante e inofensivo.
    const reclamada = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'ACTIVA', interrumpidaEn: { not: null } },
      data: {
        interrumpidaEn: null,
        finProgramado: nuevoFin,
        segundosCompensados: { increment: devolver },
      },
    });
    if (reclamada.count === 0) return false;
    this.invalidarCache(sesionId);

    await this.prisma.silla.update({
      where: { id: sesion.sillaId },
      data: { finSesionActual: nuevoFin },
    });
    this.sillas.invalidarCache(sesion.sillaId);

    this.programar(sesionId, nuevoFin, () =>
      this.finalizarSesion(sesionId, 'tiempo_cumplido'),
    );
    this.logger.log(
      `Silla ${sesion.silla.nombre}: volvió la luz tras ${caidoSeg}s, ` +
        `se devolvieron ${devolver}s (nuevo fin ${nuevoFin.toISOString()})`,
    );
    return true;
  }

  /**
   * El corte pasó del umbral. No encendemos una silla que probablemente esté
   * vacía: se cierra la sesión y se emite un crédito por el tiempo que le
   * quedaba, canjeable escaneando cualquier QR.
   */
  async cerrarPorCorte(sesionId: string): Promise<Credito | null> {
    this.cancelarTimer(sesionId);
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion || sesion.estado !== 'ACTIVA' || !sesion.interrumpidaEn) return null;

    // Intento de OFF por las dudas: si el equipo sigue caído falla, y no
    // importa — al volver arranca con el relé abierto igual.
    try {
      await this.shelly.setRele(sesion.silla.deviceIdShelly, false);
    } catch (e) {
      this.logger.warn(
        `No se pudo apagar el relé de ${sesion.silla.nombre} tras el corte: ${e}`,
      );
    }

    const restanteAlCorteSeg = sesion.finProgramado
      ? Math.round((sesion.finProgramado.getTime() - sesion.interrumpidaEn.getTime()) / 1000)
      : 0;

    // Un corte sobre el final no es un turno perdido: se da por cumplido.
    if (restanteAlCorteSeg <= RESTO_DESPRECIABLE_SEG) {
      await this.cerrarYLiberar(sesion.id, sesion.sillaId, {
        estado: 'COMPLETADA',
        motivo: 'corte_sobre_el_final',
        estadoTurno: 'COMPLETADA',
        desde: ['ACTIVA'],
      });
      this.logger.log(
        `Silla ${sesion.silla.nombre}: corte con ${restanteAlCorteSeg}s por delante, sesión dada por cumplida`,
      );
      return null;
    }

    const cerrada = await this.cerrarYLiberar(sesion.id, sesion.sillaId, {
      estado: 'CANCELADA',
      motivo: 'corte_de_energia',
      estadoTurno: 'CANCELADA',
      desde: ['ACTIVA'],
    });
    if (!cerrada) return null; // otra pasada ya la cerró y ya emitió el vale

    const credito = await this.emitirCreditoDe(sesion.id, {
      // El vale es por lo que le quedaba, no por un turno entero.
      duracionMin: Math.min(
        sesion.duracionMin,
        Math.max(1, Math.ceil(restanteAlCorteSeg / 60)),
      ),
      esManual: sesion.esManual,
      motivo: 'corte_de_energia',
      prioridadDesde: sesion.pagadaEn ?? sesion.inicio ?? sesion.creadaEn,
    });
    this.logger.warn(
      `Silla ${sesion.silla.nombre}: corte largo, sesión ${sesion.id} cerrada` +
        (credito ? ` con crédito ${credito.codigo} por ${credito.duracionMin} min` : ''),
    );
    return credito;
  }

  /** Las cortesías del dueño no generan vales: no hay plata del cliente atrás. */
  private async emitirCreditoDe(
    sesionId: string,
    params: {
      duracionMin: number;
      esManual: boolean;
      motivo: string;
      prioridadDesde: Date;
    },
  ): Promise<Credito | null> {
    if (params.esManual) return null;
    try {
      return await this.creditos.emitir({
        duracionMin: params.duracionMin,
        motivo: params.motivo,
        sesionOrigenId: sesionId,
        prioridadDesde: params.prioridadDesde,
      });
    } catch (e) {
      // La sesión ya quedó cerrada. Que no se pueda emitir el vale es un
      // problema de plata del cliente: tiene que gritar en los logs para que
      // el dueño se lo dé a mano desde el panel.
      this.logger.error(
        `NO SE PUDO EMITIR EL VALE de la sesión ${sesionId} (${params.motivo}, ` +
          `${params.duracionMin} min): hay que compensar al cliente a mano. ${e}`,
      );
      return null;
    }
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

    // Corte en curso: el timer venció mientras la silla estaba a oscuras. No
    // la damos por cumplida — EnergiaService resuelve cuando vuelva la luz
    // (reanudar con el tiempo devuelto, o cerrar con crédito).
    if (sesion.interrumpidaEn) {
      this.logger.warn(
        `Sesión ${sesionId} venció durante un corte de energía, cierre postergado`,
      );
      return;
    }

    try {
      await this.shelly.setRele(sesion.silla.deviceIdShelly, false);
    } catch (e) {
      // Fallback: el ON dejó programado el auto-off en la nube (toggle_after),
      // así que el relé se corta solo a los MARGEN_AUTO_OFF_SEG del vencimiento.
      this.logger.error(
        `No se pudo apagar el relé de ${sesion.silla.nombre}; actúa el auto-off del Shelly. ${e}`,
      );
    }

    // Sin pulso de retorno configurado: se libera como siempre.
    if (tiemposDeSilla(sesion).retornoSeg <= 0) {
      await this.cerrarYLiberar(sesionId, sesion.sillaId, {
        estado: 'COMPLETADA',
        motivo,
        estadoTurno: 'COMPLETADA',
        desde: ['ACTIVA'],
      });
      this.logger.log(`Silla ${sesion.silla.nombre}: LIBRE (${motivo})`);
      return;
    }

    // Fase SALIDA: la silla queda acostada al cortarle la corriente. Tras una
    // pausa se le da un pulso de energía para que el cliente presione START y
    // la silla vuelva a la posición vertical. La silla sigue EN_USO: no se
    // puede pagar ni la toma la cola hasta que termine.
    const ahora = new Date();
    const salidaHasta = new Date(
      ahora.getTime() + (tiemposDeSilla(sesion).pausaRetornoSeg + tiemposDeSilla(sesion).retornoSeg) * 1000,
    );
    const reclamada = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'ACTIVA', interrumpidaEn: null },
      data: { estado: 'SALIDA', salidaHasta, motivoCierre: motivo },
    });
    if (reclamada.count === 0) return;
    this.invalidarCache(sesionId);
    await this.prisma.silla.update({
      where: { id: sesion.sillaId },
      data: { finSesionActual: salidaHasta },
    });
    this.sillas.invalidarCache(sesion.sillaId);

    const inicioRetorno = new Date(ahora.getTime() + tiemposDeSilla(sesion).pausaRetornoSeg * 1000);
    this.programar(sesionId, inicioRetorno, () => this.iniciarRetorno(sesionId));
    this.logger.log(
      `Silla ${sesion.silla.nombre}: tiempo cumplido, SALIDA (retorno a las ` +
        `${inicioRetorno.toISOString()}, libre a las ${salidaHasta.toISOString()})`,
    );
  }

  /**
   * Pulso de retorno: corriente por `retornoSeg` para que el cliente presione
   * START y la silla se levante. El corte lo hace el propio Shelly con
   * `toggle_after` — no depende de la latencia de la nube, y hay que cortar
   * justo ahí: si la silla arranca otra pasada se vuelve a acostar.
   */
  async iniciarRetorno(sesionId: string) {
    this.cancelarTimer(sesionId);
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion || sesion.estado !== 'SALIDA') return;

    try {
      await this.shelly.setRele(sesion.silla.deviceIdShelly, true, tiemposDeSilla(sesion).retornoSeg);
    } catch (e) {
      // Sin luz o sin nube: no hay pulso que dar. Se libera la silla igual.
      this.logger.error(
        `No se pudo dar el pulso de retorno a ${sesion.silla.nombre}: ${e}`,
      );
      await this.cerrarSalida(sesionId);
      return;
    }

    // El pulso arranca cuando el relé cerró, no cuando se programó.
    const salidaHasta = new Date(Date.now() + tiemposDeSilla(sesion).retornoSeg * 1000);
    await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'SALIDA' },
      data: { salidaHasta },
    });
    this.invalidarCache(sesionId);
    await this.prisma.silla.update({
      where: { id: sesion.sillaId },
      data: { finSesionActual: salidaHasta },
    });
    this.sillas.invalidarCache(sesion.sillaId);

    this.programar(sesionId, salidaHasta, () => this.cerrarSalida(sesionId));
    this.logger.log(
      `Silla ${sesion.silla.nombre}: pulso de retorno por ${tiemposDeSilla(sesion).retornoSeg}s`,
    );
  }

  /** Fin de la fase SALIDA: OFF de respaldo y la silla queda LIBRE. */
  async cerrarSalida(sesionId: string) {
    this.cancelarTimer(sesionId);
    const sesion = await this.prisma.sesion.findUnique({
      where: { id: sesionId },
      include: { silla: true },
    });
    if (!sesion || sesion.estado !== 'SALIDA') return;

    // Normalmente el `toggle_after` ya lo cortó; esto es por las dudas.
    try {
      await this.shelly.setRele(sesion.silla.deviceIdShelly, false);
    } catch (e) {
      this.logger.warn(
        `No se pudo confirmar el OFF tras el retorno de ${sesion.silla.nombre}: ${e}`,
      );
    }

    const motivo = sesion.motivoCierre ?? 'tiempo_cumplido';
    await this.cerrarYLiberar(sesionId, sesion.sillaId, {
      estado: 'COMPLETADA',
      motivo,
      estadoTurno: 'COMPLETADA',
      desde: ['SALIDA'],
    });
    this.logger.log(`Silla ${sesion.silla.nombre}: LIBRE (${motivo})`);
  }

  /**
   * Cierre común: sesión, silla y — si vino de la cola — el turno enlazado.
   * Si el turno no se cierra, el cliente queda "EN_USO" para siempre y lo
   * seguimos mandando a esa pantalla cada vez que escanea un QR.
   *
   * Nota Bloque C: acá también se cierra el `turno` enlazado (si lo hay),
   * pero este servicio no invalida la cache de turno de ColaService —
   * SesionesModule no puede depender de ColaModule sin crear un ciclo
   * (ColaModule ya depende de SesionesModule). Ese turno queda cubierto
   * solo por el TTL corto de la cache (ver informe del Bloque C).
   */
  private async cerrarYLiberar(
    sesionId: string,
    sillaId: string,
    opciones: {
      estado: 'COMPLETADA' | 'CANCELADA';
      motivo: string;
      estadoTurno: 'COMPLETADA' | 'CANCELADA';
      desde: ('ACTIVA' | 'ESPERANDO_ENERGIA' | 'SALIDA')[];
    },
  ): Promise<boolean> {
    const ahora = new Date();

    // El cierre se reclama primero y de forma condicional: es lo que hace que
    // dos chequeos superpuestos no cierren la misma sesión dos veces (y, más
    // importante, no emitan dos vales por el mismo corte).
    const reclamada = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: { in: opciones.desde } },
      data: {
        estado: opciones.estado,
        finReal: ahora,
        motivoCierre: opciones.motivo,
        interrumpidaEn: null,
        salidaHasta: null,
      },
    });
    if (reclamada.count === 0) return false;
    this.invalidarCache(sesionId);

    await this.prisma.$transaction([
      // La silla se libera solo si sigue tomada por ESTA sesión.
      this.prisma.silla.updateMany({
        where: { id: sillaId, estado: { in: ['EN_USO', 'PAGO_PENDIENTE', 'RESERVADA'] } },
        data: { estado: 'LIBRE', finSesionActual: null },
      }),
      this.prisma.turno.updateMany({
        where: { sesionId, estado: 'EN_USO' },
        data: {
          estado: opciones.estadoTurno,
          finReal: ahora,
          motivoCierre: opciones.motivo,
        },
      }),
    ]);
    this.sillas.invalidarCache(sillaId);
    return true;
  }

  /** Parada de emergencia: corta ya, marca la sesión como CANCELADA. */
  async detenerEmergencia(sillaId: string) {
    const silla = await this.prisma.silla.findUnique({ where: { id: sillaId } });
    if (!silla) throw new NotFoundException('Sillón no encontrado');

    await this.shelly.setRele(silla.deviceIdShelly, false);

    const activa = await this.prisma.sesion.findFirst({
      where: {
        sillaId,
        estado: { in: ['ACTIVA', 'SALIDA', 'ESPERANDO_ENERGIA', 'ESPERANDO_CONFIRMACION'] },
      },
    });
    if (activa) {
      this.cancelarTimer(activa.id);
      await this.prisma.sesion.update({
        where: { id: activa.id },
        data: {
          estado: 'CANCELADA',
          finReal: new Date(),
          motivoCierre: 'parada_de_emergencia',
          interrumpidaEn: null,
          salidaHasta: null,
        },
      });
      this.invalidarCache(activa.id);
      // Mismo motivo que en finalizarSesion: si venía de la cola, cerrarla.
      // (Igual nota que en cerrarYLiberar: la cache de turno de ColaService
      // no se invalida acá para no crear un ciclo de módulos.)
      await this.prisma.turno.updateMany({
        where: { sesionId: activa.id, estado: 'EN_USO' },
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
    this.sillas.invalidarCache(sillaId);
    this.logger.warn(`Parada de emergencia en silla ${silla.nombre}`);
    return { ok: true, sillaId, sesionCancelada: activa?.id ?? null };
  }

  /** Activación manual desde el panel admin (sin pago). */
  async activarManual(sillaId: string, duracionMin?: number) {
    const silla = await this.prisma.silla.findUnique({ where: { id: sillaId } });
    if (!silla) throw new NotFoundException('Sillón no encontrado');
    if (silla.estado === 'EN_USO') {
      throw new ConflictException('El sillón ya está en uso');
    }

    const sesion = await this.prisma.sesion.create({
      data: {
        sillaId,
        externalReference: `manual-${crypto.randomUUID()}`,
        monto: 0,
        duracionMin: duracionMin ?? silla.duracionMin,
        ...tiemposDeSilla(silla),
        esManual: true,
      },
    });
    return this.activarSesion(sesion.id);
  }

  // ── PAGO_PENDIENTE → LIBRE (timeout) ──────────────────────────

  async expirarPagoPendiente(sesionId: string) {
    this.cancelarTimer(sesionId);

    // Solo expira si sigue PENDIENTE. Una sesión ya pagada que está esperando
    // que vuelva la luz (ESPERANDO_ENERGIA) NO se toca acá: el pago ya entró.
    const expirada = await this.prisma.sesion.updateMany({
      where: { id: sesionId, estado: 'PENDIENTE' },
      data: {
        estado: 'CANCELADA',
        finReal: new Date(),
        motivoCierre: 'pago_no_recibido',
      },
    });
    if (expirada.count === 0) return;
    this.invalidarCache(sesionId);

    const sesion = await this.prisma.sesion.findUnique({ where: { id: sesionId } });
    if (sesion) {
      await this.prisma.silla.updateMany({
        where: { id: sesion.sillaId, estado: 'PAGO_PENDIENTE' },
        data: { estado: 'LIBRE' },
      });
      this.sillas.invalidarCache(sesion.sillaId);
    }
    this.logger.log(`Sesión ${sesionId} expirada sin pago, silla liberada`);
  }

  // ── Consulta pública ──────────────────────────────────────────

  /**
   * Estado de la sesión propia del cliente, para el polling de la pantalla
   * de "tu masaje". La landing sondea el estado de la SILLA, que no alcanza
   * acá: si un corte cierra la sesión, la silla vuelve a LIBRE y el cliente
   * no se enteraría de que le quedó un crédito.
   *
   * Bloque C: la fila de `sesion` (con el `silla` mínimo incluido) se
   * cachea; `segundosRestantes` se recalcula siempre en vivo a partir de
   * `finProgramado`, nunca se cachea el número ya calculado. El crédito NO
   * se cachea: `creditos.porSesion` es un único `findFirst` por columna
   * indexada (`sesionOrigenId`), tan barato como para que agregarle otra
   * cache no valga la complejidad extra de mantener dos TTLs sincronizados.
   */
  async estadoPublico(sesionId: string) {
    const sesion = await this.cache.obtenerOCargar(sesionId, () =>
      this.prisma.sesion.findUnique({
        where: { id: sesionId },
        include: { silla: { select: { id: true, nombre: true } } },
      }),
    );
    if (!sesion) throw new NotFoundException('Sesión no encontrada');

    // Durante un corte el reloj se congela (null): el backend no descuenta.
    const reloj = sesion.interrumpidaEn
      ? { segundosRestantes: null, fase: null, segundosSalida: null }
      : calcularReloj(sesion);

    const segundosVentana =
      sesion.estado === 'ESPERANDO_CONFIRMACION'
        ? Math.max(
            0,
            Math.round(
              ((sesion.pagadaEn ?? sesion.creadaEn).getTime() +
                VENTANA_CONFIRMACION_SESION_MIN * 60_000 -
                Date.now()) /
                1000,
            ),
          )
        : null;

    const credito = await this.creditos.porSesion(sesionId);

    return {
      id: sesion.id,
      estado: sesion.estado,
      sillaId: sesion.silla.id,
      sillaNombre: sesion.silla.nombre,
      duracionMin: sesion.duracionMin,
      segundosRestantes: reloj.segundosRestantes,
      fase: reloj.fase,
      segundosSalida: reloj.segundosSalida,
      segundosVentana,
      interrumpida: sesion.interrumpidaEn !== null,
      cortes: sesion.cortes,
      segundosCompensados: sesion.segundosCompensados,
      motivoCierre: sesion.motivoCierre,
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

  // ── Timers ────────────────────────────────────────────────────

  private programar(sesionId: string, cuando: Date, fn: () => Promise<unknown>) {
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
