import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HeartbeatService, SaludSilla } from '../shelly/heartbeat.service';
import { ShellyService } from '../shelly/shelly.service';
import { MAX_ESPERA_ENERGIA_SEG, SesionesService, UMBRAL_CORTE_SEG } from './sesiones.service';

/**
 * Cada cuánto se revisa el estado de energía. Es más seguido que el
 * heartbeat (30 s) a propósito: cuando vuelve la luz queremos reenganchar en
 * el primer dato fresco que haya, no esperar medio minuto más.
 */
const INTERVALO_MS = 15_000;

/**
 * Antigüedad máxima de una lectura del heartbeat para tomar decisiones con
 * ella. Si Shelly Cloud dejó de contestar, la última lectura queda vieja y no
 * sirve para decidir: mejor no hacer nada que cerrar sesiones por un
 * problema que es nuestro y no del local.
 */
const FRESCURA_MAX_MS = 3 * 60_000;

/**
 * Cuánto tiene que sostenerse la condición "relé encendido sin sesión" antes
 * de apagarlo. Evita apagar por una lectura vieja justo después de encender.
 */
const CONFIRMACION_HUERFANO_MS = 60_000;

/**
 * Reacciona a lo que ve el heartbeat. Es el único que decide qué hacer con
 * un corte de energía; SesionesService pone las transiciones y este servicio
 * elige cuál corresponde.
 *
 * Vive en SesionesModule (y no dentro de ShellyModule, al lado del
 * heartbeat) para no dejar a ShellyModule dependiendo de las sesiones: la
 * dependencia va en un solo sentido, sesiones → shelly.
 */
@Injectable()
export class EnergiaService {
  private readonly logger = new Logger(EnergiaService.name);
  /** sillaId → desde cuándo vemos el relé encendido sin sesión detrás. */
  private huerfanosDesde = new Map<string, number>();
  /**
   * Una pasada a la vez. Cada comando a Shelly Cloud pasa por un throttle de
   * ~1 s, así que con varias sillas una pasada puede durar más que el
   * intervalo: sin esto, dos pasadas superpuestas reanudarían el mismo corte
   * dos veces.
   */
  private corriendo = false;
  /**
   * Apagar relés huérfanos solo es seguro si esta instancia es la ÚNICA que
   * maneja esos equipos. Si otro backend (beta, o uno local en desarrollo)
   * tiene cargada una silla con el mismo `deviceIdShelly`, para él toda
   * sesión de producción es un relé "sin sesión" y la corta al minuto — la
   * sesión sigue EN_USO en el panel de producción con la silla apagada.
   * `APAGAR_RELES_HUERFANOS=false` desactiva el apagado (queda el aviso).
   */
  private readonly apagarHuerfanos: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sesiones: SesionesService,
    private readonly heartbeat: HeartbeatService,
    private readonly shelly: ShellyService,
    @Optional() config?: ConfigService,
  ) {
    const valor = (config?.get<string>('APAGAR_RELES_HUERFANOS', '') ?? '').trim().toLowerCase();
    this.apagarHuerfanos = valor !== 'false' && valor !== '0';
    if (!this.apagarHuerfanos) {
      this.logger.warn(
        'APAGAR_RELES_HUERFANOS=false: los relés encendidos sin sesión solo se avisan, no se apagan',
      );
    }
  }

  @Interval(INTERVALO_MS)
  async revisar(): Promise<void> {
    if (this.corriendo) return;
    this.corriendo = true;
    try {
      const salud = new Map(this.heartbeat.getSalud().map((s) => [s.sillaId, s]));

      const sesiones = await this.prisma.sesion.findMany({
        where: { estado: { in: ['ACTIVA', 'ESPERANDO_ENERGIA'] } },
        include: { silla: { select: { nombre: true } } },
      });

      for (const sesion of sesiones) {
        // Red de seguridad: si el heartbeat dejó de traer datos (Shelly Cloud
        // caída), una sesión no puede quedarse colgada en "interrumpida" para
        // siempre — la silla nunca volvería a estar libre.
        if (
          sesion.interrumpidaEn &&
          this.caidoSeg(sesion.interrumpidaEn) >= UMBRAL_CORTE_SEG * 2
        ) {
          await this.sesiones.cerrarPorCorte(sesion.id);
          continue;
        }

        // Sin heartbeat (recién arrancado, o Shelly Cloud caída) no hay nada
        // que decidir más allá de la red de seguridad de arriba.
        const s = salud.get(sesion.sillaId);
        if (!s || !this.esFresca(s)) continue;

        if (sesion.estado === 'ESPERANDO_ENERGIA') {
          await this.revisarEsperaDeEnergia(sesion, s);
        } else {
          await this.revisarSesionActiva(sesion, s);
        }
      }

      if (salud.size > 0) await this.apagarRelesHuerfanos(salud);
    } catch (e) {
      this.logger.error(`Error revisando energía: ${e}`);
    } finally {
      this.corriendo = false;
    }
  }

  private esFresca(s: SaludSilla): boolean {
    return Date.now() - s.ultimoChequeo.getTime() <= FRESCURA_MAX_MS;
  }

  // ── Sesión pagada esperando que vuelva la luz ─────────────────

  private async revisarEsperaDeEnergia(
    sesion: { id: string; pagadaEn: Date | null; creadaEn: Date; silla: { nombre: string } },
    s: SaludSilla,
  ): Promise<void> {
    const esperandoSeg = Math.round(
      (Date.now() - (sesion.pagadaEn ?? sesion.creadaEn).getTime()) / 1000,
    );

    if (esperandoSeg >= MAX_ESPERA_ENERGIA_SEG) {
      await this.sesiones.vencerEsperaEnergia(sesion.id);
      return;
    }
    if (!s.online) return; // todavía sin luz, se sigue esperando

    try {
      await this.sesiones.activarSesion(sesion.id);
      this.logger.log(
        `Silla ${sesion.silla.nombre}: volvió la energía, sesión ${sesion.id} activada ` +
          `tras esperar ${esperandoSeg}s`,
      );
    } catch (e) {
      this.logger.warn(`Reintento de activación de ${sesion.id} falló: ${e}`);
    }
  }

  // ── Sesión andando ────────────────────────────────────────────

  private async revisarSesionActiva(
    sesion: {
      id: string;
      inicio: Date | null;
      interrumpidaEn: Date | null;
      silla: { nombre: string };
    },
    s: SaludSilla,
  ): Promise<void> {
    if (!s.online) {
      if (!sesion.interrumpidaEn) {
        await this.sesiones.registrarCorte(sesion.id, this.inicioDelCorte(sesion.inicio, s));
        return;
      }
      // Sigue caído: si ya pasó el umbral no esperamos a que vuelva para
      // cerrar — el cliente hace rato que se fue.
      if (this.caidoSeg(sesion.interrumpidaEn) >= UMBRAL_CORTE_SEG) {
        await this.sesiones.cerrarPorCorte(sesion.id);
      }
      return;
    }

    // ── El equipo responde ──
    if (sesion.interrumpidaEn) {
      if (this.caidoSeg(sesion.interrumpidaEn) >= UMBRAL_CORTE_SEG) {
        await this.sesiones.cerrarPorCorte(sesion.id);
      } else {
        await this.reanudar(sesion.id, sesion.silla.nombre);
      }
      return;
    }

    // Corte corto que el equipo alcanzó a reconectar entre dos chequeos: la
    // nube nunca lo marcó offline, pero el relé volvió abierto. Para el
    // cliente es el mismo corte, así que se trata igual.
    if (s.releEncendido === false && this.arranqueYaAsentado(sesion.inicio, s)) {
      this.logger.warn(
        `Silla ${sesion.silla.nombre}: relé abierto con la sesión andando ` +
          `(corte breve que no se vio como desconexión)`,
      );
      const marcado = await this.sesiones.registrarCorte(sesion.id, s.ultimoChequeo);
      if (marcado) await this.reanudar(sesion.id, sesion.silla.nombre);
    }
  }

  /**
   * La lectura tiene que ser posterior al encendido, y el arranque tiene que
   * haber tenido tiempo de reflejarse en la nube. Sin esto, la cache del
   * heartbeat (hasta 30 s vieja) haría ver como "relé apagado" una sesión
   * que acaba de encender.
   */
  private arranqueYaAsentado(inicio: Date | null, s: SaludSilla): boolean {
    if (!inicio) return false;
    // Se mide desde el último comando al relé, no solo desde el inicio: al
    // reanudar tras un corte se vuelve a mandar el ON, y la lectura que el
    // heartbeat tomó antes de eso (equipo recién reconectado, relé abierto)
    // no puede tomarse como un corte nuevo.
    const comando = this.shelly.ultimoComandoEn(s.deviceId);
    const desde = Math.max(inicio.getTime(), comando?.getTime() ?? 0);
    if (s.ultimoChequeo.getTime() <= desde) return false;
    return Date.now() - desde > 60_000;
  }

  /**
   * Cuándo empezó el corte, lo mejor que se puede saber. Shelly Cloud tarda
   * en marcar offline un equipo que se quedó sin luz, así que la hora del
   * chequeo que lo detecta llega tarde: se toma el último chequeo en que se
   * lo vio online, para que ese rato también se le devuelva al cliente. Nunca
   * antes del inicio de la sesión.
   */
  private inicioDelCorte(inicio: Date | null, s: SaludSilla): Date {
    const visto = s.ultimoOnline ?? s.ultimoChequeo;
    if (inicio && visto.getTime() < inicio.getTime()) return inicio;
    return visto;
  }

  private caidoSeg(desde: Date): number {
    return Math.round((Date.now() - desde.getTime()) / 1000);
  }

  private async reanudar(sesionId: string, nombreSilla: string): Promise<void> {
    try {
      await this.sesiones.reanudarTrasCorte(sesionId);
    } catch (e) {
      // Queda `interrumpidaEn` puesto: se reintenta en el próximo tick y el
      // tiempo caído se le sigue acreditando al cliente.
      this.logger.warn(`No se pudo reanudar ${nombreSilla} tras el corte: ${e}`);
    }
  }

  // ── Relé encendido sin nadie detrás ───────────────────────────

  /**
   * Si el Shelly quedó configurado para restaurar su último estado, al
   * volver la luz puede encender una silla que ya no tiene sesión. El
   * heartbeat ya lo alertaba; acá además se apaga.
   */
  private async apagarRelesHuerfanos(salud: Map<string, SaludSilla>): Promise<void> {
    const conSesion = new Set(
      (
        await this.prisma.sesion.findMany({
          // SALIDA incluida: durante el pulso de retorno el relé está
          // encendido a propósito.
          where: { estado: { in: ['ACTIVA', 'SALIDA', 'ESPERANDO_ENERGIA'] } },
          select: { sillaId: true },
        })
      ).map((s) => s.sillaId),
    );

    for (const [sillaId, s] of salud) {
      const huerfano =
        s.online && s.releEncendido === true && !conSesion.has(sillaId) && this.esFresca(s);
      if (!huerfano) {
        this.huerfanosDesde.delete(sillaId);
        continue;
      }

      const desde = this.huerfanosDesde.get(sillaId);
      if (!desde) {
        this.huerfanosDesde.set(sillaId, Date.now());
        continue;
      }
      if (Date.now() - desde < CONFIRMACION_HUERFANO_MS) continue;

      if (!this.apagarHuerfanos) {
        // Se avisa una vez por episodio: se reinicia el contador para no
        // llenar el log cada 15 s.
        this.huerfanosDesde.set(sillaId, Date.now());
        this.logger.warn(
          `Silla ${s.nombre} (${s.deviceId}): relé encendido sin sesión en esta base; ` +
            'no se apaga (APAGAR_RELES_HUERFANOS=false)',
        );
        continue;
      }

      try {
        await this.shelly.setRele(s.deviceId, false);
        this.huerfanosDesde.delete(sillaId);
        this.logger.warn(
          `Silla ${s.nombre} (${s.deviceId}): relé encendido sin sesión activa, ` +
            'se apagó automáticamente. Si había una sesión en otro ambiente, ese ' +
            'device está cargado en dos backends (ver docs/DEPLOY.md)',
        );
      } catch (e) {
        this.logger.error(`No se pudo apagar el relé huérfano de ${s.nombre}: ${e}`);
      }
    }
  }
}
