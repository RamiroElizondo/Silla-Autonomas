import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SesionesService } from '../sesiones/sesiones.service';
import { SillasService } from '../sillas/sillas.service';
import { MercadoPagoService } from './mercadopago.service';

@Injectable()
export class PagosService {
  private readonly logger = new Logger(PagosService.name);
  private readonly backendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mp: MercadoPagoService,
    private readonly sesiones: SesionesService,
    private readonly sillas: SillasService,
    config: ConfigService,
  ) {
    this.backendUrl = config.get<string>('BACKEND_URL', '');
  }

  /**
   * Flujo de checkout:
   * 1. Reserva la silla (LIBRE → PAGO_PENDIENTE, con timeout de 3 min).
   * 2. Crea la sesión con external_reference único.
   * 3. Crea la Preferencia en MP y devuelve la URL de Checkout Pro.
   */
  async iniciarCheckout(sillaId: string) {
    const silla = await this.sillas.obtener(sillaId);
    const externalReference = `${randomUUID()}|${sillaId}`;

    const sesion = await this.sesiones.crearSesionPendiente(silla, externalReference);

    try {
      const pref = await this.mp.crearPreferencia({
        titulo: `${silla.nombre} — ${silla.duracionMin} min de masaje`,
        precio: Number(silla.precio),
        externalReference,
        sillaId,
        notificationUrl: `${this.backendUrl}/webhooks/mercadopago`,
      });
      return { sesionId: sesion.id, initPoint: pref.initPoint };
    } catch (e) {
      // Si MP falla, liberar la silla de inmediato
      await this.sesiones.expirarPagoPendiente(sesion.id);
      throw e;
    }
  }

  /**
   * Procesa una notificación de pago (ya validada la firma).
   * Reglas críticas: idempotencia por payment_id, verificación contra
   * la API de MP, y control de monto.
   */
  async procesarNotificacionPago(paymentId: string, rawBody: unknown) {
    // Idempotencia: si ya lo procesamos, ignorar
    const existente = await this.prisma.pago.findUnique({
      where: { paymentIdMp: paymentId },
    });
    if (existente) {
      this.logger.log(`Webhook duplicado para pago ${paymentId}, ignorado`);
      return;
    }

    // Verificar el pago real contra la API de MP
    const pago = await this.mp.obtenerPago(paymentId);
    if (!pago) {
      this.logger.warn(`Pago ${paymentId} no encontrado en MP`);
      return;
    }

    if (!pago.external_reference) {
      this.logger.warn(`Pago ${paymentId} sin external_reference, ignorado`);
      return;
    }

    const sesion = await this.prisma.sesion.findUnique({
      where: { externalReference: pago.external_reference },
    });
    if (!sesion) {
      this.logger.warn(
        `Pago ${paymentId} con external_reference desconocido: ${pago.external_reference}`,
      );
      return;
    }

    const aprobado = pago.status === 'approved';
    const montoOk = pago.transaction_amount >= Number(sesion.monto);

    // Registrar el pago siempre (aprobado o no) para auditoría
    await this.prisma.pago.create({
      data: {
        sesionId: sesion.id,
        paymentIdMp: paymentId,
        monto: pago.transaction_amount,
        estado: aprobado ? 'APROBADO' : 'RECHAZADO',
        rawWebhook: JSON.parse(JSON.stringify(rawBody ?? {})),
      },
    });

    if (!aprobado) {
      this.logger.log(`Pago ${paymentId} en estado ${pago.status}, no activa silla`);
      return;
    }
    if (!montoOk) {
      this.logger.error(
        `Pago ${paymentId} aprobado pero monto insuficiente: ${pago.transaction_amount} < ${sesion.monto}`,
      );
      return;
    }

    await this.sesiones.activarSesion(sesion.id);
    this.logger.log(`Pago ${paymentId} aprobado → sesión ${sesion.id} activada`);
  }
}
