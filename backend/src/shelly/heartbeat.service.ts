import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DispositivoCloud, ShellyService } from './shelly.service';

export interface SaludSilla {
  sillaId: string;
  nombre: string;
  deviceId: string;
  online: boolean;
  releEncendido: boolean | null;
  potenciaW: number | null;
  temperaturaC: number | null;
  alertas: string[];
  ultimoChequeo: Date;
  /**
   * Último chequeo en el que el equipo figuraba online (null si todavía no
   * se lo vio online desde que arrancó el backend). Cuando se corta la luz,
   * Shelly Cloud tarda en marcarlo offline: esta es la mejor estimación de
   * cuándo empezó el corte, y es la que se usa para compensar al cliente.
   */
  ultimoOnline: Date | null;
}

/**
 * Umbral de temperatura del relé, en °C. Es un valor conservador y no una
 * especificación de Shelly: un Shelly 1 Gen3 embutido ronda los 50-55 °C en
 * reposo, así que 80 °C indica que el equipo está mal ventilado o que la
 * carga lo está exigiendo. Ajustar cuando haya lecturas reales con la silla
 * funcionando.
 */
export const TEMP_ALERTA_C = 80;

/**
 * Antigüedad máxima de una lectura para considerarla representativa del
 * momento. Más vieja que esto significa que no estamos pudiendo hablar con
 * Shelly Cloud, no que el local esté sin luz.
 */
export const FRESCURA_MAX_MS = 3 * 60_000;

/**
 * Heartbeat: cada 30s consulta el estado real de cada Shelly.
 * Genera alertas si el dispositivo no responde o si el relé está ON
 * con consumo 0W (silla desenchufada/rota — requiere Plus 1PM para medir).
 */
@Injectable()
export class HeartbeatService {
  private readonly logger = new Logger(HeartbeatService.name);
  private salud = new Map<string, SaludSilla>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly shelly: ShellyService,
  ) {}

  @Interval(30_000)
  async chequear(): Promise<void> {
    const sillas = await this.prisma.silla.findMany();
    if (sillas.length === 0) return;

    // La API v2 no tiene un "traeme todo": se consultan los device ids de las
    // sillas registradas, en lotes de 10 (rate limit: ~1 req/seg por cuenta).
    let dispositivos: DispositivoCloud[];
    try {
      dispositivos = await this.shelly.listarDispositivos();
    } catch (e) {
      this.logger.warn(`Heartbeat sin datos de Shelly Cloud: ${e}`);
      return;
    }
    const porDevice = new Map(dispositivos.map((d) => [d.deviceId, d]));

    for (const silla of sillas) {
      // El estado que devuelve v2 ya es el del momento (mismo endpoint que
      // usaría una consulta directa), así que no hace falta reconfirmar.
      const dev = porDevice.get(silla.deviceIdShelly);
      const estado = {
        online: dev?.online ?? false,
        releEncendido: dev?.releEncendido ?? null,
        potenciaW: dev?.potenciaW ?? null,
        temperaturaC: dev?.temperaturaC ?? null,
      };
      const alertas: string[] = [];

      if (!dev) {
        alertas.push('Device ID no encontrado en la cuenta de Shelly Cloud');
      } else if (!estado.online) {
        alertas.push('Dispositivo Shelly sin conexión');
      }
      if (
        silla.estado === 'EN_USO' &&
        estado.releEncendido === true &&
        estado.potenciaW !== null &&
        estado.potenciaW < 1
      ) {
        alertas.push('Relé encendido pero consumo 0W: sillón desenchufado o con falla');
      }
      if (
        silla.estado !== 'EN_USO' &&
        silla.estado !== 'PAGO_PENDIENTE' &&
        silla.estado !== 'RESERVADA' &&
        estado.releEncendido === true
      ) {
        alertas.push('Relé encendido sin sesión activa');
      }
      if (estado.temperaturaC !== null && estado.temperaturaC >= TEMP_ALERTA_C) {
        alertas.push(
          `Relé a ${Math.round(estado.temperaturaC)} °C: revisar ventilación del gabinete`,
        );
      }

      if (alertas.length) {
        this.logger.warn(`[${silla.nombre}] ${alertas.join(' | ')}`);
      }

      // La hora de la lectura, no la de ahora: con la cache o el fallback
      // ante un rechazo el dato puede tener varios segundos (o más).
      const ahora = dev?.leidoEn ?? new Date();
      const previo = this.salud.get(silla.id);
      this.salud.set(silla.id, {
        sillaId: silla.id,
        nombre: silla.nombre,
        deviceId: silla.deviceIdShelly,
        online: estado.online,
        releEncendido: estado.releEncendido,
        potenciaW: estado.potenciaW,
        temperaturaC: estado.temperaturaC,
        alertas,
        ultimoChequeo: ahora,
        ultimoOnline: estado.online ? ahora : (previo?.ultimoOnline ?? null),
      });
    }
  }

  getSalud(): SaludSilla[] {
    return [...this.salud.values()];
  }

  getSaludDe(sillaId: string): SaludSilla | null {
    return this.salud.get(sillaId) ?? null;
  }

  /**
   * True solo si hay una lectura FRESCA que dice que el equipo no responde.
   *
   * Sin lectura (recién arrancó el backend) o con una lectura vieja (Shelly
   * Cloud dejó de contestar) devuelve false a propósito: ante la duda no
   * bloqueamos la venta por un problema que puede ser nuestro.
   */
  estaOffline(sillaId: string): boolean {
    const s = this.salud.get(sillaId);
    if (!s) return false;
    if (Date.now() - s.ultimoChequeo.getTime() > FRESCURA_MAX_MS) return false;
    return !s.online;
  }
}
