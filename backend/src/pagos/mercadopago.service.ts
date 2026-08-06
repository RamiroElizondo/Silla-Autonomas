import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

export interface PagoMP {
  id: number;
  status: string; // approved | rejected | pending | ...
  transaction_amount: number;
  external_reference: string | null;
  [k: string]: unknown;
}

/** Cliente de la API de Mercado Pago (Checkout Pro + Payments), vía SDK oficial. */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  private readonly webhookSecret: string;
  private readonly frontendUrl: string;
  private readonly preference: Preference;
  private readonly payment: Payment;

  constructor(config: ConfigService) {
    const accessToken = config.get<string>('MP_ACCESS_TOKEN', '');
    this.webhookSecret = config.get<string>('MP_WEBHOOK_SECRET', '');
    this.frontendUrl = config.get<string>('FRONTEND_URL', '');

    const client = new MercadoPagoConfig({ accessToken });
    this.preference = new Preference(client);
    this.payment = new Payment(client);
  }

  /** Crea la Preferencia de Checkout Pro. Devuelve la URL de pago (init_point). */
  async crearPreferencia(params: {
    titulo: string;
    precio: number;
    externalReference: string;
    sillaId: string;
    notificationUrl: string;
  }): Promise<{ id: string; initPoint: string }> {
    try {
      const result = await this.preference.create({
        body: {
          items: [
            {
              id: params.sillaId,
              title: params.titulo,
              quantity: 1,
              unit_price: params.precio,
              currency_id: 'ARS',
            },
          ],
          external_reference: params.externalReference,
          notification_url: params.notificationUrl,
          back_urls: {
            success: `${this.frontendUrl}/silla/${params.sillaId}/exito`,
            failure: `${this.frontendUrl}/silla/${params.sillaId}/fracaso`,
            pending: `${this.frontendUrl}/silla/${params.sillaId}/fracaso`,
          },
          auto_return: 'approved',
          // La reserva de la silla dura 3 min: no aceptar pagos tardíos
          expires: true,
          expiration_date_to: new Date(Date.now() + 3 * 60_000).toISOString(),
        },
      });

      if (!result.id || !result.init_point) {
        throw new Error('Respuesta de MP sin id/init_point');
      }
      return { id: result.id, initPoint: result.init_point };
    } catch (err) {
      this.logger.error(`Error creando preferencia: ${JSON.stringify(err)}`);
      throw new Error('No se pudo crear la preferencia de pago');
    }
  }

  /**
   * Consulta el pago REAL contra la API de MP.
   * Regla crítica: nunca confiar solo en el body del webhook.
   */
  async obtenerPago(paymentId: string): Promise<PagoMP | null> {
    try {
      const result = await this.payment.get({ id: paymentId });
      return result as unknown as PagoMP;
    } catch (err) {
      this.logger.warn(`GET /v1/payments/${paymentId} → ${JSON.stringify(err)}`);
      return null;
    }
  }

  /**
   * Valida la firma HMAC del webhook (header x-signature).
   * Manifest según docs de MP: "id:{data.id};request-id:{x-request-id};ts:{ts};"
   */
  validarFirma(params: {
    xSignature: string | undefined;
    xRequestId: string | undefined;
    dataId: string | undefined;
  }): boolean {
    if (!this.webhookSecret) {
      this.logger.warn('MP_WEBHOOK_SECRET no configurado: firma NO validada');
      return true; // permitir en desarrollo; en producción configurar SIEMPRE
    }
    if (!params.xSignature) return false;

    const partes = Object.fromEntries(
      params.xSignature.split(',').map((p) => p.trim().split('=', 2)),
    ) as { ts?: string; v1?: string };
    if (!partes.ts || !partes.v1) return false;

    let manifest = '';
    if (params.dataId) manifest += `id:${params.dataId.toLowerCase()};`;
    if (params.xRequestId) manifest += `request-id:${params.xRequestId};`;
    manifest += `ts:${partes.ts};`;

    const esperado = createHmac('sha256', this.webhookSecret)
      .update(manifest)
      .digest('hex');

    try {
      return timingSafeEqual(Buffer.from(esperado), Buffer.from(partes.v1));
    } catch {
      return false;
    }
  }
}
