import {
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
 * Mismo mensaje y mismo status para código inexistente, ya usado o vencido
 * (Hallazgo ALTO 3): si cada caso respondiera distinto, alguien probando
 * códigos al voleo podría confirmar cuáles existen. El detalle real (cuál
 * de los tres fue) se loguea aparte, internamente, sin el código completo.
 */
const MENSAJE_CODIGO_INVALIDO = 'Código inválido o ya utilizado';

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
   * Valida y consume un código. Es UN SOLO `updateMany` condicional para
   * los tres casos de fallo (inexistente, usado, vencido): la misma
   * excepción, el mismo mensaje, y ningún camino hace una consulta de más
   * que otro — nada que se pueda medir por tiempo de respuesta. El mismo
   * `updateMany` es también lo que evita que dos toques del botón
   * "Reclamar" (o dos requests concurrentes) generen dos turnos con el
   * mismo vale: como mucho uno de los dos matchea `estado: 'DISPONIBLE'`.
   */
  async tomar(entrada: string): Promise<Credito> {
    const codigo = normalizarCodigo(entrada);
    const ahora = new Date();

    const resultado = await this.prisma.credito.updateMany({
      where: { codigo, estado: 'DISPONIBLE', venceEn: { gt: ahora } },
      data: { estado: 'CANJEADO', canjeadoEn: ahora },
    });

    if (resultado.count === 0) {
      // Fire-and-forget: diagnóstico interno sin bloquear la respuesta (si
      // esto tardara, distinguiría por tiempo el mismo caso que el mensaje
      // ya no distingue).
      this.registrarIntentoFallido(codigo).catch(() => undefined);
      throw new NotFoundException(MENSAJE_CODIGO_INVALIDO);
    }

    return this.prisma.credito.findUniqueOrThrow({ where: { codigo } });
  }

  /**
   * Detalle real de por qué falló un canje, solo para los logs — nunca para
   * la respuesta HTTP. Nunca loguea el código completo, solo un prefijo
   * (alcanza para correlacionar con el panel admin sin poder reconstruir el
   * código entero desde el log).
   */
  private async registrarIntentoFallido(codigo: string): Promise<void> {
    const credito = await this.prisma.credito.findUnique({
      where: { codigo },
      select: { id: true, estado: true, venceEn: true },
    });
    const prefijo = codigo.slice(0, 4); // ej. "LUZ-"

    if (!credito) {
      this.logger.warn(`Canje rechazado: código inexistente (prefijo "${prefijo}")`);
      return;
    }
    if (credito.estado === 'DISPONIBLE' && credito.venceEn <= new Date()) {
      // Lo marcamos vencido de una vez (si nadie lo tocó mientras tanto) en
      // vez de esperar al barrido horario — es información, no crítico.
      await this.prisma.credito.updateMany({
        where: { id: credito.id, estado: 'DISPONIBLE' },
        data: { estado: 'VENCIDO' },
      });
      this.logger.warn(
        `Canje rechazado: código con prefijo "${prefijo}" venció (id ${credito.id})`,
      );
      return;
    }
    this.logger.warn(
      `Canje rechazado: código con prefijo "${prefijo}" ya estaba ${credito.estado} (id ${credito.id})`,
    );
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
