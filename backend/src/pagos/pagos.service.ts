import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ColaService } from '../cola/cola.service';
import {
  MercadoPagoService,
  type PagoMP,
} from '../mercadopago/mercadopago.service';
import { PrismaService } from '../prisma/prisma.service';
import { SesionesService } from '../sesiones/sesiones.service';
import { SillasService } from '../sillas/sillas.service';

@Injectable()
export class PagosService {
  private readonly logger = new Logger(PagosService.name);
  // Fallback cuando el checkout se dispara sin `origin` (ej. pruebas manuales
  // por curl/Postman). En el uso normal lo reemplaza window.location.origin.
  private readonly frontendUrlFallback: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mp: MercadoPagoService,
    private readonly sesiones: SesionesService,
    private readonly sillas: SillasService,
    private readonly cola: ColaService,
    config: ConfigService,
  ) {
    this.frontendUrlFallback = config.get<string>('FRONTEND_URL', '');
  }

  /**
   * Flujo de checkout:
   * 1. Reserva la silla (LIBRE → PAGO_PENDIENTE, con timeout de 3 min).
   * 2. Crea la sesión con external_reference único.
   * 3. Crea la Preferencia en MP y devuelve la URL de Checkout Pro.
   *
   * `origin` (opcional) es el origin público desde el que el cliente abrió
   * la landing y se usa para los back_urls. El Webhook se configura en el
   * panel de Mercado Pago para no sobreescribir la configuración firmada.
   */
  async iniciarCheckout(sillaId: string, origin?: string) {
    const silla = await this.sillas.obtener(sillaId);
    const externalReference = `${randomUUID()}|${sillaId}`;

    const sesion = await this.sesiones.crearSesionPendiente(silla, externalReference);

    const frontendOrigin = (origin ?? this.frontendUrlFallback).replace(/\/+$/, '');

    try {
      const pref = await this.mp.crearPreferencia({
        titulo: `${silla.nombre} — ${silla.duracionMin} min de masaje`,
        precio: Number(silla.precio),
        externalReference,
        itemId: sillaId,
        successUrl: `${frontendOrigin}/silla/${sillaId}/exito`,
        failureUrl: `${frontendOrigin}/silla/${sillaId}/fracaso`,
        pendingUrl: `${frontendOrigin}/silla/${sillaId}/fracaso`,
      });
      return { sesionId: sesion.id, initPoint: pref.initPoint };
    } catch (e) {
      // Si MP falla, liberar la silla de inmediato
      await this.sesiones.expirarPagoPendiente(sesion.id);
      throw e;
    }
  }

  /**
   * El cliente cancela/abandona el checkout de MP (vuelve a `/fracaso`, o
   * pega "atrás" desde adentro de Checkout Pro). Libera la silla al toque
   * en vez de esperar el timeout de 3 min — así el siguiente cliente (o el
   * mismo, si se arrepintió del arrepentimiento) puede pagar enseguida.
   *
   * Reutiliza `expirarPagoPendiente`, que ya es idempotente y solo actúa si
   * la sesión sigue en PENDIENTE: si el pago se aprobó justo antes de que
   * esto llegue, no hace nada (gana el pago real). Se valida que la sesión
   * pertenezca a esta silla para que no se pueda cancelar la sesión de otra
   * silla adivinando un UUID.
   */
  async cancelarCheckout(sillaId: string, sesionId: string) {
    const sesion = await this.prisma.sesion.findUnique({ where: { id: sesionId } });
    if (!sesion || sesion.sillaId !== sillaId) {
      return { ok: false };
    }
    await this.sesiones.expirarPagoPendiente(sesionId);
    return { ok: true };
  }

  /**
   * Respaldo del back_url cuando el Webhook todavía no llegó. El paymentId
   * del navegador se usa únicamente para consultar la API de Mercado Pago;
   * también se comprueba que external_reference pertenezca a esta silla.
   */
  async confirmarRetornoSilla(sillaId: string, paymentId: string) {
    const pago = await this.mp.obtenerPago(paymentId);
    if (!pago?.external_reference) {
      throw new NotFoundException('Pago no encontrado en Mercado Pago');
    }
    if (pago.status !== 'approved') {
      throw new ConflictException(`El pago todavía está en estado ${pago.status}`);
    }

    const sesion = await this.prisma.sesion.findUnique({
      where: { externalReference: pago.external_reference },
      select: { id: true, sillaId: true },
    });
    if (!sesion || sesion.sillaId !== sillaId) {
      throw new NotFoundException('El pago no corresponde a esta silla');
    }

    await this.procesarPagoVerificado(paymentId, pago, {
      origen: 'checkout_return',
    });

    const estado = await this.prisma.sesion.findUnique({
      where: { id: sesion.id },
      select: { estado: true },
    });
    if (estado?.estado !== 'ACTIVA') {
      throw new ConflictException(
        'El pago fue aprobado, pero la reserva ya venció. Avisá al encargado.',
      );
    }
    return { ok: true };
  }

  /** Mismo respaldo para el pago de ingreso a la cola compartida. */
  async confirmarRetornoTurno(turnoId: string, paymentId: string) {
    const pago = await this.mp.obtenerPago(paymentId);
    if (!pago?.external_reference) {
      throw new NotFoundException('Pago no encontrado en Mercado Pago');
    }
    if (pago.status !== 'approved') {
      throw new ConflictException(`El pago todavía está en estado ${pago.status}`);
    }

    const turno = await this.prisma.turno.findUnique({
      where: { externalReference: pago.external_reference },
      select: { id: true },
    });
    if (!turno || turno.id !== turnoId) {
      throw new NotFoundException('El pago no corresponde a este turno');
    }

    await this.procesarPagoVerificado(paymentId, pago, {
      origen: 'checkout_return',
    });

    const estado = await this.prisma.turno.findUnique({
      where: { id: turno.id },
      select: { estado: true },
    });
    if (!estado || ['ESPERANDO_PAGO', 'CANCELADA'].includes(estado.estado)) {
      throw new ConflictException(
        'El pago fue aprobado, pero el turno ya venció. Avisá al encargado.',
      );
    }
    return { ok: true };
  }

  /**
   * Procesa una notificación de pago (ya validada la firma).
   * Reglas críticas: idempotencia por payment_id, verificación contra
   * la API de MP, y control de monto.
   *
   * El external_reference puede ser de dos flujos distintos: pago directo a
   * una silla puntual (Sesion) o pago para entrar a la cola compartida
   * (Turno) — se prueba primero Sesion y, si no matchea, Turno.
   */
  async procesarNotificacionPago(paymentId: string, rawBody: unknown) {
    // Idempotencia: si ya lo procesamos, ignorar
    const existente = await this.prisma.pago.findUnique({
      where: { paymentIdMp: paymentId },
    });
    if (existente?.estado === 'APROBADO') {
      this.logger.log(`Webhook duplicado para pago ${paymentId}, ignorado`);
      return;
    }

    // Verificar el pago real contra la API de MP
    const pago = await this.mp.obtenerPago(paymentId);
    if (!pago) {
      this.logger.warn(`Pago ${paymentId} no encontrado en MP`);
      return;
    }

    await this.procesarPagoVerificado(paymentId, pago, rawBody);
  }

  private async procesarPagoVerificado(
    paymentId: string,
    pago: PagoMP,
    rawBody: unknown,
  ) {
    // El Webhook y el retorno del navegador pueden llegar al mismo tiempo.
    const existente = await this.prisma.pago.findUnique({
      where: { paymentIdMp: paymentId },
    });
    if (existente?.estado === 'APROBADO') {
      this.logger.log(`Pago ${paymentId} ya procesado, ignorado`);
      return;
    }

    if (!pago.external_reference) {
      this.logger.warn(`Pago ${paymentId} sin external_reference, ignorado`);
      return;
    }

    const sesion = await this.prisma.sesion.findUnique({
      where: { externalReference: pago.external_reference },
    });
    if (sesion) {
      await this.procesarPagoDeSesion(paymentId, pago, rawBody, sesion);
      return;
    }

    const turno = await this.prisma.turno.findUnique({
      where: { externalReference: pago.external_reference },
    });
    if (turno) {
      await this.procesarPagoDeTurno(paymentId, pago, rawBody, turno);
      return;
    }

    this.logger.warn(
      `Pago ${paymentId} con external_reference desconocido: ${pago.external_reference}`,
    );
  }

  private async procesarPagoDeSesion(
    paymentId: string,
    pago: { status: string; transaction_amount: number },
    rawBody: unknown,
    sesion: { id: string; monto: unknown },
  ) {
    const aprobado = pago.status === 'approved';
    const montoOk = pago.transaction_amount >= Number(sesion.monto);

    const debeAplicar = await this.registrarEstadoPago(
      paymentId,
      aprobado,
      {
        sesionId: sesion.id,
        monto: pago.transaction_amount,
        rawWebhook: JSON.parse(JSON.stringify(rawBody ?? {})),
      },
    );

    if (!aprobado) {
      this.logger.log(`Pago ${paymentId} en estado ${pago.status}, no activa silla`);
      return;
    }
    if (!debeAplicar) return;
    if (!montoOk) {
      this.logger.error(
        `Pago ${paymentId} aprobado pero monto insuficiente: ${pago.transaction_amount} < ${sesion.monto}`,
      );
      return;
    }

    try {
      await this.sesiones.activarSesion(sesion.id);
      this.logger.log(`Pago ${paymentId} aprobado → sesión ${sesion.id} activada`);
    } catch (e) {
      if (e instanceof ConflictException) {
        // La sesión ya no estaba PENDIENTE (se canceló por timeout, por el
        // endpoint de cancelación, o la silla ya se liberó). El pago quedó
        // igual registrado como APROBADO en la tabla `pagos` para auditoría
        // — hay que revisarlo a mano (probable reembolso vía MP) porque el
        // cliente pagó pero no se le encendió la silla.
        this.logger.error(
          `Pago ${paymentId} aprobado pero la sesión ${sesion.id} ya no estaba pendiente ` +
            `(revisar manualmente — posible reembolso): ${e.message}`,
        );
        return;
      }
      throw e;
    }
  }

  private async procesarPagoDeTurno(
    paymentId: string,
    pago: { status: string; transaction_amount: number },
    rawBody: unknown,
    turno: { id: string; monto: unknown },
  ) {
    const aprobado = pago.status === 'approved';
    const montoOk = pago.transaction_amount >= Number(turno.monto);

    const debeAplicar = await this.registrarEstadoPago(
      paymentId,
      aprobado,
      {
        turnoId: turno.id,
        monto: pago.transaction_amount,
        rawWebhook: JSON.parse(JSON.stringify(rawBody ?? {})),
      },
    );

    if (!aprobado) {
      this.logger.log(`Pago ${paymentId} en estado ${pago.status}, no anota en cola`);
      return;
    }
    if (!debeAplicar) return;
    if (!montoOk) {
      this.logger.error(
        `Pago ${paymentId} aprobado pero monto insuficiente: ${pago.transaction_amount} < ${turno.monto}`,
      );
      return;
    }

    await this.cola.procesarPagoAprobado(turno.id);
    this.logger.log(`Pago ${paymentId} aprobado → turno ${turno.id} en cola`);
  }

  /**
   * Registra una notificación de forma atómica frente a la carrera entre el
   * Webhook y el back_url. Devuelve true solo al proceso que debe aplicar el
   * pago aprobado a la silla/cola.
   */
  private async registrarEstadoPago(
    paymentId: string,
    aprobado: boolean,
    data: Omit<Prisma.PagoUncheckedCreateInput, 'paymentIdMp' | 'estado'>,
  ): Promise<boolean> {
    if (aprobado) {
      const actualizado = await this.prisma.pago.updateMany({
        where: { paymentIdMp: paymentId, estado: 'RECHAZADO' },
        data: {
          estado: 'APROBADO',
          monto: data.monto,
          rawWebhook: data.rawWebhook,
        },
      });
      if (actualizado.count > 0) return true;
    }

    try {
      await this.prisma.pago.create({
        data: {
          ...data,
          paymentIdMp: paymentId,
          estado: aprobado ? 'APROBADO' : 'RECHAZADO',
        },
      });
      return aprobado;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }
}
