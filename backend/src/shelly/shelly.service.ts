import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EstadoDispositivo {
  online: boolean;
  releEncendido: boolean | null;
  /** Potencia en W. Solo disponible en modelos con medición (1PM). */
  potenciaW: number | null;
  /** Modelo/código y generación reportados por Shelly Cloud, si están disponibles. */
  modelo: string | null;
}

export interface DispositivoCloud {
  deviceId: string;
  online: boolean;
  modelo: string | null;
  generacion: string | null;
  releEncendido: boolean | null;
  potenciaW: number | null;
  midePotencia: boolean;
}

/**
 * Control del relé vía Shelly Cloud API.
 * El servidor está en internet y el Shelly detrás del NAT del local,
 * por eso se usa la nube de Shelly y no la API local.
 */
@Injectable()
export class ShellyService {
  private readonly logger = new Logger(ShellyService.name);
  private readonly server: string;
  private readonly authKey: string;

  // Shelly Cloud limita a ~1 request/segundo por cuenta.
  // Todas las llamadas pasan por una cola que las espacia.
  private static readonly ESPACIADO_MS = 1100;
  private cadena: Promise<unknown> = Promise.resolve();
  private ultimaLlamada = 0;

  // Cache de la lista de dispositivos (evita repetir all_status)
  private static readonly CACHE_TTL_MS = 15_000;
  private cacheDispositivos: { datos: DispositivoCloud[]; expira: number } | null = null;

  constructor(config: ConfigService) {
    this.server = config.get<string>('SHELLY_SERVER', '');
    this.authKey = config.get<string>('SHELLY_AUTH_KEY', '');
  }

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

  /** Enciende o apaga el relé. Lanza error si la nube de Shelly no confirma. */
  async setRele(deviceId: string, encender: boolean): Promise<void> {
    const body = new URLSearchParams({
      auth_key: this.authKey,
      id: deviceId,
      channel: '0',
      turn: encender ? 'on' : 'off',
    });

    const res = await this.throttle(() =>
      fetch(`${this.server}/device/relay/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.isok !== true) {
      this.logger.error(
        `Fallo al ${encender ? 'encender' : 'apagar'} relé ${deviceId}: ${JSON.stringify(json)}`,
      );
      throw new Error(`Shelly Cloud rechazó el comando (device ${deviceId})`);
    }
    this.logger.log(`Relé ${deviceId} → ${encender ? 'ON' : 'OFF'}`);
  }

  /** Consulta estado del dispositivo (online, relé, potencia si el modelo mide). */
  async getEstado(deviceId: string): Promise<EstadoDispositivo> {
    const body = new URLSearchParams({ auth_key: this.authKey, id: deviceId });

    try {
      const res = await this.throttle(() =>
        fetch(`${this.server}/device/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        }),
      );
      const json: any = await res.json();

      if (!json.isok) {
        return { online: false, releEncendido: null, potenciaW: null, modelo: null };
      }

      const online: boolean = json.data?.online === true || json.data?.online === 1;
      return this.parsearStatus(json.data?.device_status ?? {}, online);
    } catch (e) {
      this.logger.warn(`Sin respuesta de Shelly Cloud para ${deviceId}: ${e}`);
      return { online: false, releEncendido: null, potenciaW: null, modelo: null };
    }
  }

  /**
   * Lista todos los dispositivos de la cuenta Shelly Cloud, con modelo y
   * generación detectados. Se usa al dar de alta una silla para elegir
   * el device correcto sin tipear el ID a mano.
   */
  async listarDispositivos(): Promise<DispositivoCloud[]> {
    // Cache: evita golpear el rate limit de Shelly Cloud
    if (this.cacheDispositivos && this.cacheDispositivos.expira > Date.now()) {
      return this.cacheDispositivos.datos;
    }

    const body = new URLSearchParams({ auth_key: this.authKey });

    const res = await this.throttle(() =>
      fetch(`${this.server}/device/all_status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    const json: any = await res.json();
    if (!json.isok) {
      // Si Shelly rechaza (ej. TOO_MANY_REQUESTS) y hay cache vieja, usarla
      if (this.cacheDispositivos) {
        this.logger.warn(
          `Shelly Cloud rechazó all_status, usando cache: ${JSON.stringify(json.errors ?? json)}`,
        );
        return this.cacheDispositivos.datos;
      }
      throw new Error(`Shelly Cloud no devolvió la lista de dispositivos: ${JSON.stringify(json.errors ?? json)}`);
    }

    const statuses: Record<string, any> = json.data?.devices_status ?? {};
    const datos = Object.entries(statuses).map(([deviceId, ds]) => {
      const info = ds?._dev_info ?? {};
      // El flag online de all_status puede venir en _dev_info o en la raíz
      const online =
        info.online === true ||
        info.online === 1 ||
        ds?.online === true ||
        ds?.online === 1;
      const estado = this.parsearStatus(ds, online);
      return {
        deviceId,
        online: estado.online,
        modelo: info.code ?? estado.modelo,
        generacion: info.gen ?? null,
        releEncendido: estado.releEncendido,
        potenciaW: estado.potenciaW,
        midePotencia: estado.potenciaW !== null,
      };
    });

    this.cacheDispositivos = {
      datos,
      expira: Date.now() + ShellyService.CACHE_TTL_MS,
    };
    return datos;
  }

  /** Interpreta el device_status según generación (Gen2/Gen3: switch:0; Gen1: relays). */
  private parsearStatus(ds: any, online: boolean): EstadoDispositivo {
    const modelo: string | null = ds?._dev_info?.code ?? null;

    // El flag online de Shelly Cloud es poco confiable; el status del propio
    // dispositivo trae "cloud.connected" (Gen2/3) o "cloud.connected" en Gen1,
    // que refleja la conexión real.
    const conectado =
      online ||
      ds?.cloud?.connected === true ||
      ds?.['cloud']?.connected === 1;

    // Gen2/Gen3 (Plus 1, 1 Gen3, 1PM, ...): componente "switch:0"
    const sw = ds?.['switch:0'];
    if (sw) {
      return {
        online: conectado,
        releEncendido: sw.output ?? null,
        potenciaW: typeof sw.apower === 'number' ? sw.apower : null,
        modelo,
      };
    }

    // Gen1 fallback: relays[0] / meters[0]
    const rele = ds?.relays?.[0];
    return {
      online: conectado,
      releEncendido: rele?.ison ?? null,
      potenciaW: typeof ds?.meters?.[0]?.power === 'number' ? ds.meters[0].power : null,
      modelo,
    };
  }
}
