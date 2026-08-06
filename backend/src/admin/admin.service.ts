import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HeartbeatService } from '../shelly/heartbeat.service';
import { ShellyService } from '../shelly/shelly.service';
import { ActualizarSillaDto } from './dto/actualizar-silla.dto';
import { CrearSillaDto } from './dto/crear-silla.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: HeartbeatService,
    private readonly shelly: ShellyService,
  ) {}

  /**
   * Verifica que el device exista en la cuenta de Shelly Cloud y devuelve
   * su modelo/generación. Falla si el ID no existe o el equipo está offline.
   */
  private async validarDispositivo(deviceId: string): Promise<string> {
    const dispositivos = await this.shelly.listarDispositivos();
    const dev = dispositivos.find((d) => d.deviceId === deviceId);
    if (!dev) {
      throw new BadRequestException(
        `El device ${deviceId} no existe en la cuenta de Shelly Cloud`,
      );
    }
    if (!dev.online) {
      // all_status puede traer el flag online desactualizado: confirmar en vivo
      const directo = await this.shelly.getEstado(deviceId);
      if (!directo.online) {
        throw new BadRequestException(
          `El device ${deviceId} (${dev.modelo ?? 'modelo desconocido'}) está offline: verificar WiFi del local`,
        );
      }
    }
    return [dev.modelo, dev.generacion].filter(Boolean).join(' / ') || 'desconocido';
  }

  /** Alta de silla: valida el Shelly contra la nube y guarda su modelo. */
  async crearSilla(dto: CrearSillaDto) {
    const duplicada = await this.prisma.silla.findFirst({
      where: { deviceIdShelly: dto.deviceIdShelly },
    });
    if (duplicada) {
      throw new BadRequestException(
        `El device ${dto.deviceIdShelly} ya está vinculado a la silla "${duplicada.nombre}"`,
      );
    }

    const modeloShelly = await this.validarDispositivo(dto.deviceIdShelly);
    return this.prisma.silla.create({
      data: { ...dto, modeloShelly },
    });
  }

  /** Estado en vivo de todas las sillas + salud del hardware. */
  async sillas() {
    const sillas = await this.prisma.silla.findMany({ orderBy: { nombre: 'asc' } });
    const salud = new Map(this.heartbeat.getSalud().map((s) => [s.sillaId, s]));
    return sillas.map((s) => ({
      ...s,
      precio: Number(s.precio),
      salud: salud.get(s.id) ?? null,
    }));
  }

  /** Historial de sesiones, paginado, más recientes primero. */
  async sesiones(take = 50, skip = 0) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.sesion.findMany({
        take,
        skip,
        orderBy: { creadaEn: 'desc' },
        include: {
          silla: { select: { nombre: true } },
          pagos: { select: { paymentIdMp: true, monto: true, estado: true } },
        },
      }),
      this.prisma.sesion.count(),
    ]);
    return { total, items };
  }

  /** Métricas simples: hoy y últimos 30 días. */
  async metricas() {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const hace30 = new Date(Date.now() - 30 * 24 * 60 * 60_000);

    const [sesionesHoy, ingresosHoy, sesiones30, ingresos30] =
      await this.prisma.$transaction([
        this.prisma.sesion.count({
          where: { estado: 'COMPLETADA', inicio: { gte: hoy } },
        }),
        this.prisma.pago.aggregate({
          _sum: { monto: true },
          where: { estado: 'APROBADO', recibidoEn: { gte: hoy } },
        }),
        this.prisma.sesion.count({
          where: { estado: 'COMPLETADA', inicio: { gte: hace30 } },
        }),
        this.prisma.pago.aggregate({
          _sum: { monto: true },
          where: { estado: 'APROBADO', recibidoEn: { gte: hace30 } },
        }),
      ]);

    return {
      hoy: { sesiones: sesionesHoy, ingresos: Number(ingresosHoy._sum.monto ?? 0) },
      ultimos30Dias: { sesiones: sesiones30, ingresos: Number(ingresos30._sum.monto ?? 0) },
    };
  }

  async actualizarSilla(id: string, dto: ActualizarSillaDto) {
    const silla = await this.prisma.silla.findUnique({ where: { id } });
    if (!silla) throw new NotFoundException('Silla no encontrada');

    // Si cambia el dispositivo, revalidar contra Shelly Cloud
    let modeloShelly = silla.modeloShelly;
    if (dto.deviceIdShelly && dto.deviceIdShelly !== silla.deviceIdShelly) {
      modeloShelly = await this.validarDispositivo(dto.deviceIdShelly);
    }
    return this.prisma.silla.update({
      where: { id },
      data: { ...dto, modeloShelly },
    });
  }

  /** Prueba de conexión: estado real del Shelly de una silla, en el momento. */
  async probarSilla(id: string) {
    const silla = await this.prisma.silla.findUnique({ where: { id } });
    if (!silla) throw new NotFoundException('Silla no encontrada');
    const estado = await this.shelly.getEstado(silla.deviceIdShelly);
    return {
      sillaId: silla.id,
      deviceId: silla.deviceIdShelly,
      modeloRegistrado: silla.modeloShelly,
      ...estado,
      midePotencia: estado.potenciaW !== null,
    };
  }
}
