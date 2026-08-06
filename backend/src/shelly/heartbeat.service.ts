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
  alertas: string[];
  ultimoChequeo: Date;
}

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

    // Una sola llamada a Shelly Cloud para todos los dispositivos
    // (rate limit: ~1 req/seg por cuenta)
    let dispositivos: DispositivoCloud[];
    try {
      dispositivos = await this.shelly.listarDispositivos();
    } catch (e) {
      this.logger.warn(`Heartbeat sin datos de Shelly Cloud: ${e}`);
      return;
    }
    const porDevice = new Map(dispositivos.map((d) => [d.deviceId, d]));

    for (const silla of sillas) {
      const dev = porDevice.get(silla.deviceIdShelly);
      let estado = {
        online: dev?.online ?? false,
        releEncendido: dev?.releEncendido ?? null,
        potenciaW: dev?.potenciaW ?? null,
      };

      // all_status a veces reporta "offline" desactualizado (estado cacheado
      // por Shelly Cloud). Antes de alertar, confirmar con consulta directa.
      if (dev && !dev.online) {
        const directo = await this.shelly.getEstado(silla.deviceIdShelly);
        if (directo.online) {
          estado = {
            online: true,
            releEncendido: directo.releEncendido,
            potenciaW: directo.potenciaW,
          };
        }
      }
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
        alertas.push('Relé encendido pero consumo 0W: silla desenchufada o con falla');
      }
      if (silla.estado !== 'EN_USO' && estado.releEncendido === true) {
        alertas.push('Relé encendido sin sesión activa');
      }

      if (alertas.length) {
        this.logger.warn(`[${silla.nombre}] ${alertas.join(' | ')}`);
      }

      this.salud.set(silla.id, {
        sillaId: silla.id,
        nombre: silla.nombre,
        deviceId: silla.deviceIdShelly,
        online: estado.online,
        releEncendido: estado.releEncendido,
        potenciaW: estado.potenciaW,
        alertas,
        ultimoChequeo: new Date(),
      });
    }
  }

  getSalud(): SaludSilla[] {
    return [...this.salud.values()];
  }
}
