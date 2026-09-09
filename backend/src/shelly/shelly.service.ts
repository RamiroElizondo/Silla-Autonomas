import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface EstadoDispositivo {
  online: boolean;
  releEncendido: boolean | null;
  /** Potencia en W. Solo disponible en modelos con medición (1PM). */
  potenciaW: number | null;
  /** Temperatura interna del relé en °C, si el modelo la reporta. */
  temperaturaC: number | null;
  /** Código de modelo reportado por Shelly Cloud (ej. "S3SW-001X16EU"). */
  modelo: string | null;
  /** Generación reportada por Shelly Cloud (ej. "G3"), si está disponible. */
  generacion: string | null;
}

export interface DispositivoCloud {
  deviceId: string;
  online: boolean;
  modelo: string | null;
  generacion: string | null;
  releEncendido: boolean | null;
  potenciaW: number | null;
  temperaturaC: number | null;
  midePotencia: boolean;
}

/** Envoltorio que devuelve POST /v2/devices/api/get por cada dispositivo. */
interface DispositivoV2 {
  id: string;
  type?: string;
  code?: string;
  gen?: string | number;
  online?: 0 | 1 | boolean;
  status?: any;
  settings?: any;
}

/** Traducción de los códigos de error de la Cloud Control API v2. */
const ERRORES_V2: Record<string, string> = {
  DEVICE_OFFLINE:
    'el dispositivo no está conectado a Shelly Cloud (revisar WiFi del local)',
  DEVICE_NOT_FOUND: 'el device ID no existe en esta cuenta de Shelly Cloud',
  DEVICE_FAILED_COMMAND: 'el dispositivo recibió el comando pero no pudo ejecutarlo',
  BAD_REQUEST: 'Shelly Cloud rechazó el request (parámetros inválidos)',
  INSTANCE_NOT_FOUND:
    'servidor Shelly incorrecto para esta cuenta (revisar SHELLY_SERVER)',
  UNEXPECTED_SUBSERVICE_ERROR: 'error interno de Shelly Cloud',
  HTTP_401:
    'auth_key inválida o vencida (cambia si se cambia la contraseña de la cuenta Shelly)',
  HTTP_429: 'se superó el límite de 1 request/segundo de Shelly Cloud',
};

/** Error de la API v2, con el código crudo disponible para decidir reintentos. */
export class ShellyApiError extends Error {
  constructor(
    readonly codigo: string,
    readonly mensajes: string[] = [],
  ) {
    const detalle = mensajes.filter(Boolean).join('; ');
    super(
      `${ERRORES_V2[codigo] ?? codigo}${detalle ? ` — ${detalle}` : ''} [${codigo}]`,
    );
    this.name = 'ShellyApiError';
  }
}

function describir(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function desconocido(): EstadoDispositivo {
  return {
    online: false,
    releEncendido: null,
    potenciaW: null,
    temperaturaC: null,
    modelo: null,
    generacion: null,
  };
}

/**
 * Control del relé vía Shelly Cloud Control API v2.
 *
 * El servidor está en internet y el Shelly detrás del NAT del local, por eso
 * se usa la nube de Shelly y no la API local.
 *
 * Endpoints (docs: https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2):
 *   POST {SHELLY_SERVER}/v2/devices/api/get?auth_key=…         → estado (hasta 10 ids)
 *   POST {SHELLY_SERVER}/v2/devices/api/set/switch?auth_key=…  → relé ON/OFF
 *
 * Los endpoints viejos (/device/status, /device/relay/control, /device/all_status)
 * están marcados como deprecados por Shelly y ya no se usan acá.
 */
@Injectable()
export class ShellyService {
  private readonly logger = new Logger(ShellyService.name);
  private readonly server: string;
  private readonly authKey: string;

  /** Máximo de device ids por request que acepta /v2/devices/api/get. */
  private static readonly IDS_POR_LOTE = 10;

  // Shelly Cloud limita a ~1 request/segundo por cuenta.
  // Todas las llamadas pasan por una cola que las espacia.
  private static readonly ESPACIADO_MS = 1100;
  private cadena: Promise<unknown> = Promise.resolve();
  private ultimaLlamada = 0;

  // Cache del estado de las sillas registradas (solo para la consulta por
  // defecto del heartbeat; las consultas con ids explícitos van siempre en vivo).
  private static readonly CACHE_TTL_MS = 15_000;
  private cacheDispositivos: { datos: DispositivoCloud[]; expira: number } | null =
    null;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.server = config.get<string>('SHELLY_SERVER', '').replace(/\/+$/, '');
    this.authKey = config.get<string>('SHELLY_AUTH_KEY', '');
  }

  // ── Transporte ────────────────────────────────────────────────

  /** Encola una llamada garantizando el espaciado mínimo entre requests. */
  private throttle<T>(fn: () => Promise<T>): Promise<T> {
    const resultado = this.cadena.then(async () => {
      const espera = this.ultimaLlamada + ShellyService.ESPACIADO_MS - Date.now();
      if (espera > 0) await new Promise((r) => setTimeout(r, espera));
      this.ultimaLlamada = Date.now();
      return fn();
    });
    this.cadena = resultado.catch(() => undefined);
    return resultado;
  }

  /**
   * POST a la API v2. A diferencia de la API vieja no hay campo `isok`:
   * éxito = HTTP 2xx sin campo `error`; el error viene como
   * `{ error: "DEVICE_OFFLINE", data: { messages: [...] } }`.
   */
  private async postV2<T>(ruta: string, body: unknown): Promise<T> {
    const url = `${this.server}/v2/devices/api/${ruta}?auth_key=${encodeURIComponent(
      this.authKey,
    )}`;

    const res = await this.throttle(() =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    const texto = await res.text();
    let json: any;
    if (texto) {
      try {
        json = JSON.parse(texto);
      } catch {
        json = undefined;
      }
    }

    if (json && !Array.isArray(json) && typeof json.error === 'string') {
      throw new ShellyApiError(json.error, json.data?.messages ?? []);
    }
    if (!res.ok) {
      throw new ShellyApiError(`HTTP_${res.status}`, [texto.slice(0, 200)]);
    }
    return json as T;
  }

  // ── API pública ───────────────────────────────────────────────

  /**
   * Enciende o apaga el relé. Lanza error si la nube de Shelly no confirma.
   *
   * @param apagarEnSeg Al encender, programa el apagado en la propia nube
   *   (`toggle_after`) como fallback por si el backend no llega a mandar el OFF.
   *   Un ON nuevo o un OFF explícito reprograman/cancelan ese timer.
   */
  async setRele(
    deviceId: string,
    encender: boolean,
    apagarEnSeg?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      id: deviceId,
      channel: 0,
      on: encender,
    };
    if (encender && apagarEnSeg && apagarEnSeg > 0) {
      body.toggle_after = Math.round(apagarEnSeg);
    }

    try {
      await this.postV2('set/switch', body);
    } catch (e) {
      this.logger.error(
        `Fallo al ${encender ? 'encender' : 'apagar'} relé ${deviceId}: ${describir(e)}`,
      );
      throw new Error(
        `Shelly Cloud rechazó el comando (device ${deviceId}): ${describir(e)}`,
      );
    }

    // El estado cambió: la cache del heartbeat quedó vieja.
    this.cacheDispositivos = null;
    this.logger.log(
      `Relé ${deviceId} → ${encender ? 'ON' : 'OFF'}` +
        (body.toggle_after ? ` (auto-off en ${body.toggle_after}s)` : ''),
    );
  }

  /** Consulta estado del dispositivo (online, relé, potencia si el modelo mide). */
  async getEstado(deviceId: string): Promise<EstadoDispositivo> {
    try {
      const [dev] = await this.consultar([deviceId]);
      return dev ? this.parsearDispositivo(dev) : desconocido();
    } catch (e) {
      this.logger.warn(`Sin respuesta de Shelly Cloud para ${deviceId}: ${describir(e)}`);
      return desconocido();
    }
  }

  /**
   * Estado de un dispositivo puntual para el alta de sillas. Devuelve `null`
   * si el ID no existe en la cuenta; propaga el error si la nube falla, para
   * poder distinguir "no existe" de "no pudimos consultar".
   */
  async verificarDispositivo(deviceId: string): Promise<DispositivoCloud | null> {
    const [dev] = await this.consultar([deviceId], true);
    return dev ? this.aDispositivoCloud(dev) : null;
  }

  /**
   * Estado de varios dispositivos. La v2 no tiene equivalente de `all_status`:
   * hay que pasar los ids. Sin argumento, se usan los de la tabla `sillas`,
   * que es lo que necesita el heartbeat.
   *
   * Solo se devuelven los dispositivos que la cuenta reconoce: un id que no
   * está en la cuenta queda fuera de la lista (así el heartbeat lo detecta).
   */
  async listarDispositivos(deviceIds?: string[]): Promise<DispositivoCloud[]> {
    const usaCache = deviceIds === undefined;

    if (usaCache && this.cacheDispositivos && this.cacheDispositivos.expira > Date.now()) {
      return this.cacheDispositivos.datos;
    }

    const ids = deviceIds ?? (await this.idsDeSillas());
    if (ids.length === 0) return [];

    let crudos: DispositivoV2[];
    try {
      crudos = await this.consultar(ids);
    } catch (e) {
      // Si Shelly rechaza (ej. rate limit) y hay cache vieja, usarla.
      if (usaCache && this.cacheDispositivos) {
        this.logger.warn(
          `Shelly Cloud rechazó el get, usando cache: ${describir(e)}`,
        );
        return this.cacheDispositivos.datos;
      }
      throw new Error(
        `Shelly Cloud no devolvió el estado de los dispositivos: ${describir(e)}`,
      );
    }

    const datos = crudos.map((d) => this.aDispositivoCloud(d));

    if (usaCache) {
      this.cacheDispositivos = {
        datos,
        expira: Date.now() + ShellyService.CACHE_TTL_MS,
      };
    }
    return datos;
  }

  // ── Internos ──────────────────────────────────────────────────

  /** Device ids de las sillas registradas, sin repetir. */
  private async idsDeSillas(): Promise<string[]> {
    const sillas = await this.prisma.silla.findMany({
      select: { deviceIdShelly: true },
    });
    return [...new Set(sillas.map((s) => s.deviceIdShelly).filter(Boolean))];
  }

  /**
   * POST /v2/devices/api/get en lotes de 10 ids.
   *
   * Un id que no está en la cuenta simplemente no aparece en la respuesta: no
   * rompe el lote ni devuelve DEVICE_NOT_FOUND (verificado el 2026-09-08 contra
   * la cuenta real). Por eso el que consume la lista detecta el id inexistente
   * por ausencia, no por error.
   */
  private async consultar(
    ids: string[],
    incluirSettings = false,
  ): Promise<DispositivoV2[]> {
    const salida: DispositivoV2[] = [];
    for (let i = 0; i < ids.length; i += ShellyService.IDS_POR_LOTE) {
      const lote = ids.slice(i, i + ShellyService.IDS_POR_LOTE);
      salida.push(...(await this.pedirEstado(lote, incluirSettings)));
    }
    return salida;
  }

  /**
   * Una llamada a /v2/devices/api/get (máx. 10 ids).
   *
   * `settings` solo se pide en el alta de sillas: trae la configuración
   * entera del equipo (varios KB, incluida una key del dispositivo) y no le
   * aporta nada al heartbeat, que corre cada 30 s.
   */
  private async pedirEstado(
    ids: string[],
    incluirSettings: boolean,
  ): Promise<DispositivoV2[]> {
    const json = await this.postV2<any>('get', {
      ids,
      select: incluirSettings ? ['status', 'settings'] : ['status'],
    });

    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.data)) return json.data;
    if (Array.isArray(json?.devices)) return json.devices;
    this.logger.warn(
      `Respuesta inesperada de /v2/devices/api/get: ${JSON.stringify(json)?.slice(0, 200)}`,
    );
    return [];
  }

  private aDispositivoCloud(dev: DispositivoV2): DispositivoCloud {
    const estado = this.parsearDispositivo(dev);
    return {
      deviceId: dev.id,
      online: estado.online,
      modelo: estado.modelo,
      generacion: estado.generacion,
      releEncendido: estado.releEncendido,
      potenciaW: estado.potenciaW,
      temperaturaC: estado.temperaturaC,
      midePotencia: estado.potenciaW !== null,
    };
  }

  /** Combina el envoltorio de v2 (code/gen/online) con el status del equipo. */
  private parsearDispositivo(dev: DispositivoV2): EstadoDispositivo {
    const online = dev.online === 1 || dev.online === true;
    return {
      ...this.parsearStatus(dev.status ?? {}, online),
      modelo: dev.code ?? null,
      generacion: this.parsearGeneracion(dev),
    };
  }

  /**
   * El `gen` del envoltorio identifica la familia de protocolo, no la
   * generación del equipo: un Shelly 1 Gen3 (S3SW-001X16EU) viene como "G2".
   * La generación real está en `settings.DeviceInfo.gen`, que solo llega
   * cuando se piden los settings (alta de sillas).
   */
  private parsearGeneracion(dev: DispositivoV2): string | null {
    const real = dev.settings?.DeviceInfo?.gen;
    if (real != null) return `G${real}`;
    return dev.gen != null ? String(dev.gen) : null;
  }

  /** Interpreta el status según generación (Gen2/Gen3: switch:0; Gen1: relays). */
  private parsearStatus(
    ds: any,
    online: boolean,
  ): Omit<EstadoDispositivo, 'modelo' | 'generacion'> {
    // El flag online del envoltorio puede venir desactualizado; el status del
    // propio dispositivo trae "cloud.connected", que refleja la conexión real.
    const conectado =
      online || ds?.cloud?.connected === true || ds?.cloud?.connected === 1;

    // Gen2/Gen3 (Plus 1, 1 Gen3, 1PM, ...): componente "switch:0".
    // Los modelos sin medición (Plus 1, 1 Gen3) no traen `apower` en absoluto,
    // así que potenciaW queda en null y midePotencia en false.
    const sw = ds?.['switch:0'];
    if (sw) {
      return {
        online: conectado,
        releEncendido: sw.output ?? null,
        potenciaW: typeof sw.apower === 'number' ? sw.apower : null,
        temperaturaC:
          typeof sw.temperature?.tC === 'number' ? sw.temperature.tC : null,
      };
    }

    // Gen1 fallback: relays[0] / meters[0]
    const rele = ds?.relays?.[0];
    return {
      online: conectado,
      releEncendido: rele?.ison ?? null,
      potenciaW: typeof ds?.meters?.[0]?.power === 'number' ? ds.meters[0].power : null,
      temperaturaC: typeof ds?.tmp?.tC === 'number' ? ds.tmp.tC : null,
    };
  }
}
