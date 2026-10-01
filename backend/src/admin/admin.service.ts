import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CreditosService } from '../creditos/creditos.service';
import { PrismaService } from '../prisma/prisma.service';
import { HeartbeatService } from '../shelly/heartbeat.service';
import {
  DispositivoCloud,
  INITIAL_STATE_ESPERADO,
  ShellyService,
} from '../shelly/shelly.service';
import { ActualizarSillaDto } from './dto/actualizar-silla.dto';
import { CrearSillaDto } from './dto/crear-silla.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: HeartbeatService,
    private readonly shelly: ShellyService,
    private readonly creditos: CreditosService,
  ) {}

  /**
   * Consulta un device puntual contra Shelly Cloud. La API v2 no permite
   * listar los dispositivos de la cuenta, así que el alta pasa por acá: el
   * admin ingresa el ID (está en la app Shelly y en la etiqueta del equipo)
   * y esto confirma que exista, esté online y de qué modelo es.
   *
   * Devuelve siempre 200 aunque el equipo esté offline, para que el panel
   * pueda mostrar el diagnóstico; el alta se corta más abajo.
   */
  async consultarDispositivo(deviceId: string): Promise<{
    deviceId: string;
    encontrado: boolean;
    vinculable: boolean;
    motivo: string | null;
    /** Configuración peligrosa pero no bloqueante (ver initial_state). */
    advertencia: string | null;
    dispositivo: DispositivoCloud | null;
  }> {
    let dev: DispositivoCloud | null;
    try {
      dev = await this.shelly.verificarDispositivo(deviceId);
    } catch (e) {
      throw new ServiceUnavailableException(
        `No se pudo consultar Shelly Cloud: ${e instanceof Error ? e.message : e}`,
      );
    }

    if (!dev) {
      return {
        deviceId,
        encontrado: false,
        vinculable: false,
        motivo: `El device ${deviceId} no existe en la cuenta de Shelly Cloud`,
        advertencia: null,
        dispositivo: null,
      };
    }
    if (!dev.online) {
      return {
        deviceId,
        encontrado: true,
        vinculable: false,
        motivo: `El device ${deviceId} (${dev.modelo ?? 'modelo desconocido'}) está offline: verificar WiFi del local`,
        advertencia: null,
        dispositivo: dev,
      };
    }
    return {
      deviceId,
      encontrado: true,
      vinculable: true,
      motivo: null,
      advertencia: AdminService.advertirInitialState(dev.initialState),
      dispositivo: dev,
    };
  }

  /**
   * `initial_state` decide qué hace el relé cuando vuelve la luz. Si no está
   * en "off", al volver un corte la silla puede encenderse sola sin sesión
   * detrás. No bloquea el alta (el equipo funciona igual y el backend lo
   * apaga solo), pero el dueño tiene que verlo y corregirlo en la app.
   */
  private static advertirInitialState(valor: string | null): string | null {
    if (valor === null) return null; // el equipo no lo reporta
    if (valor === INITIAL_STATE_ESPERADO) return null;
    const explicacion: Record<string, string> = {
      on: 'el sillón arranca encendido cada vez que vuelve la luz',
      restore_last:
        'al volver la luz el sillón se enciende solo si estaba encendido al cortarse',
      match_input: 'el relé sigue al interruptor físico, no al sistema',
    };
    return (
      `El Shelly tiene "Acción al encender" en "${valor}": ` +
      `${explicacion[valor] ?? 'puede encender el sillón sin sesión detrás'}. ` +
      `Ponelo en "Apagar" desde la app Shelly (Configuración → Salida → Acción al encender).`
    );
  }

  /**
   * Igual que `consultarDispositivo` pero para el alta/edición: falla si el
   * device no existe o está offline, y devuelve "modelo / generación".
   */
  private async validarDispositivo(deviceId: string): Promise<string> {
    const r = await this.consultarDispositivo(deviceId);
    if (!r.vinculable) throw new BadRequestException(r.motivo);
    return (
      [r.dispositivo?.modelo, r.dispositivo?.generacion].filter(Boolean).join(' / ') ||
      'desconocido'
    );
  }

  /** Alta de silla: valida el Shelly contra la nube y guarda su modelo. */
  async crearSilla(dto: CrearSillaDto) {
    const duplicada = await this.prisma.silla.findFirst({
      where: { deviceIdShelly: dto.deviceIdShelly },
    });
    if (duplicada) {
      throw new BadRequestException(
        `El device ${dto.deviceIdShelly} ya está vinculado al sillón "${duplicada.nombre}"`,
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

  /**
   * Turnos que ya pagaron y todavía no terminaron de usar la silla: los que
   * esperan en la cola (EN_COLA) y los que tienen silla asignada pero no
   * confirmaron (ASIGNADO). No aparecen en `sesiones()` porque la sesión
   * recién se crea cuando el cliente confirma en la silla.
   */
  async cola() {
    const items = await this.prisma.turno.findMany({
      where: { estado: { in: ['EN_COLA', 'ASIGNADO'] } },
      orderBy: { pagadoEn: 'asc' },
      include: { silla: { select: { nombre: true } } },
    });
    return items.map((t) => ({
      id: t.id,
      codigo: t.codigo,
      estado: t.estado,
      monto: Number(t.monto),
      duracionMin: t.duracionMin,
      pagadoEn: t.pagadoEn,
      asignadoEn: t.asignadoEn,
      silla: t.silla,
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

  /**
   * Vales emitidos por cortes de energía. El dueño los necesita a mano: si
   * un cliente vuelve al día siguiente con un código, acá está el respaldo
   * de qué sesión lo originó y si ya se usó.
   */
  listarCreditos(take = 50, skip = 0) {
    return this.creditos.listar(take, skip);
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
    if (!silla) throw new NotFoundException('Sillón no encontrado');

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
    if (!silla) throw new NotFoundException('Sillón no encontrado');
    // Con settings: es el lugar donde el dueño revisa un equipo ya vinculado,
    // así que también le confirmamos que `initial_state` siga bien puesto.
    const estado = await this.shelly.getEstado(silla.deviceIdShelly, true);
    return {
      sillaId: silla.id,
      deviceId: silla.deviceIdShelly,
      modeloRegistrado: silla.modeloShelly,
      ...estado,
      midePotencia: estado.potenciaW !== null,
      advertencia: AdminService.advertirInitialState(estado.initialState),
    };
  }
}
