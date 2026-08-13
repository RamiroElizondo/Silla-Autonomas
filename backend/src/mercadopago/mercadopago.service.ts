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

/**
 * Cliente de la API de Mercado Pago (Checkout Pro + Payments), vía SDK
 * oficial. Vive en su propio módulo porque lo usan tanto el pago directo a
 * una silla (PagosModule) como el pago para entrar a la cola (ColaModule).
 */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  private readonly webhookSecret: string;
  private readonly preference: Preference;
  private readonly payment: Payment;

  constructor(config: ConfigService) {
    const accessToken = config.get<string>('MP_ACCESS_TOKEN', '');
    this.webhookSecret = config.get<string>('MP_WEBHOOK_SECRET', '');

    const client = new MercadoPagoConfig({ accessToken });
    this.preference = new Preference(client);
    this.payment = new Payment(client);
  }

  /** Crea la Preferencia de Checkout Pro. Devuelve la URL de pago (init_point). */
  async crearPreferencia(params: {
    titulo: string;
    precio: number;
    externalReference: string;
    itemId: string;
    notificationUrl: string;
    successUrl: string;
    failureUrl: string;
    pendingUrl: string;
    /** Minutos de vigencia de la preferencia (por defecto 3). */
    vigenciaMin?: number;
  }): Promise<{ id: string; initPoint: string }> {
    try {
      const result = await this.preference.create({
        body: {
          items: [
            {
              id: params.itemId,
              title: params.titulo,
              quantity: 1,
              unit_price: params.precio,
              currency_id: 'ARS',
            },
          ],
          external_reference: params.externalReference,
          notification_url: params.notificationUrl,
          back_urls: {
            success: params.successUrl,
            failure: params.failureUrl,
            pending: params.pendingUrl,
          },
          auto_return: 'approved',
          // No aceptar pagos tardíos de una reserva/turno ya expirado
          expires: true,
          expiration_date_to: new Date(
            Date.now() + (params.vigenciaMin ?? 3) * 60_000,
          ).toISOString(),
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
    if (!params.xSignature) {
      this.logger.warn('Webhook sin header x-signature');
      return false;
    }

    const partes = Object.fromEntries(
      params.xSignature.split(',').map((p) => p.trim().split('=', 2)),
    ) as { ts?: string; v1?: string };
    if (!partes.ts || !partes.v1) {
      this.logger.warn(`x-signature con formato inesperado: "${params.xSignature}"`);
      return false;
    }

    let manifest = '';
    if (params.dataId) manifest += `id:${params.dataId.toLowerCase()};`;
    if (params.xRequestId) manifest += `request-id:${params.xRequestId};`;
    manifest += `ts:${partes.ts};`;

    const esperado = createHmac('sha256', this.webhookSecret)
      .update(manifest)
      .digest('hex');

    let coincide: boolean;
    try {
      coincide =
        esperado.length === partes.v1.length &&
        timingSafeEqual(Buffer.from(esperado), Buffer.from(partes.v1));
    } catch {
      coincide = false;
    }

    if (!coincide) {
      // DEBUG temporal — sacar una vez que ande.
      this.logger.warn(
        `Firma no coincide. manifest="${manifest}" secretLen=${this.webhookSecret.length} ` +
          `esperado=${esperado} recibido=${partes.v1}`,
      );
    }

    return coincide;
  }
}
