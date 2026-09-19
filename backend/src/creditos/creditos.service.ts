import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Credito } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { generarCodigoCredito, normalizarCodigo } from './codigo-credito.util';

/** Días que vale un crédito antes de vencer. */
export const VIGENCIA_CREDITO_DIAS = 7;

/**
 * Créditos: vales por tiempo ya pagado que no se pudo prestar (corte de luz
 * largo, silla sin energía cuando llegó el pago).
 *
 * El canje NO vive acá sino en ColaService, que es el dueño de los Turnos:
 * este servicio solo emite, valida y marca. Es a propósito — si emitiera
 * turnos, SesionesService → CreditosService → ColaService → SesionesService
 * quedaría en círculo.
 */
@Injectable()
export class CreditosService {
  private readonly logger = new Logger(CreditosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async emitir(params: {
    duracionMin: number;
    motivo: string;
    sesionOrigenId?: string;
    /** Antigüedad que se le respeta en la cola al canjearlo. */
    prioridadDesde: Date;
  }): Promise<Credito> {
    const codigo = await this.generarCodigoUnico();
    const credito = await this.prisma.credito.create({
      data: {
        codigo,
        duracionMin: params.duracionMin,
        motivo: params.motivo,
        prioridadDesde: params.prioridadDesde,
        sesionOrigenId: params.sesionOrigenId,
        venceEn: new Date(Date.now() + VIGENCIA_CREDITO_DIAS * 24 * 60 * 60_000),
      },
    });
    this.logger.log(
      `Crédito ${codigo} emitido: ${params.duracionMin} min (${params.motivo})`,
    );
    return credito;
  }

  /**
   * Valida y consume un código. El `updateMany` condicional es el que evita
   * que dos toques del botón "Reclamar" generen dos turnos con el mismo vale.
   */
  async tomar(entrada: string): Promise<Credito> {
    const codigo = normalizarCodigo(entrada);
    const credito = await this.prisma.credito.findUnique({ where: { codigo } });
    if (!credito) {
      throw new NotFoundException('No encontramos ese código');
    }
    if (credito.estado === 'CANJEADO') {
      throw new ConflictException('Ese código ya fue usado');
    }
    if (credito.estado === 'VENCIDO' || credito.venceEn <= new Date()) {
      await this.prisma.credito.updateMany({
        where: { id: credito.id, estado: 'DISPONIBLE' },
        data: { estado: 'VENCIDO' },
      });
      throw new ConflictException('Ese código venció');
    }

    const tomado = await this.prisma.credito.updateMany({
      where: { id: credito.id, estado: 'DISPONIBLE' },
      data: { estado: 'CANJEADO', canjeadoEn: new Date() },
    });
    if (tomado.count === 0) {
      throw new ConflictException('Ese código ya fue usado');
    }
    return credito;
  }

  /** Deja el crédito apuntando al turno que generó (trazabilidad para el panel). */
  async vincularTurno(creditoId: string, turnoId: string): Promise<void> {
    await this.prisma.credito.update({
      where: { id: creditoId },
      data: { turnoGeneradoId: turnoId },
    });
  }

  /** Devuelve el crédito emitido por una sesión, para mostrárselo al cliente. */
  porSesion(sesionId: string) {
    return this.prisma.credito.findFirst({
      where: { sesionOrigenId: sesionId },
      orderBy: { creadoEn: 'desc' },
    });
  }

  /** Listado para el panel admin: primero los que todavía se pueden usar. */
  listar(take = 50) {
    return this.prisma.credito.findMany({
      take,
      orderBy: [{ estado: 'asc' }, { creadoEn: 'desc' }],
      include: {
        sesionOrigen: { select: { id: true, silla: { select: { nombre: true } } } },
        turnoGenerado: { select: { id: true, codigo: true, estado: true } },
      },
    });
  }

  /** Barrido horario: marca vencidos los que nadie reclamó. */
  @Interval(3_600_000)
  async vencerCaducados(): Promise<void> {
    const res = await this.prisma.credito.updateMany({
      where: { estado: 'DISPONIBLE', venceEn: { lte: new Date() } },
      data: { estado: 'VENCIDO' },
    });
    if (res.count > 0) {
      this.logger.log(`${res.count} crédito(s) vencido(s) sin reclamar`);
    }
  }

  private async generarCodigoUnico(): Promise<string> {
    for (let intento = 0; intento < 20; intento++) {
      const candidato = generarCodigoCredito();
      const existe = await this.prisma.credito.findUnique({
        where: { codigo: candidato },
      });
      if (!existe) return candidato;
    }
    throw new Error('No se pudo generar un código de crédito único');
  }
}
