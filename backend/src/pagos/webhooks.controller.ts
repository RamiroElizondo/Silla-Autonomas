import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { MercadoPagoService } from './mercadopago.service';
import { PagosService } from './pagos.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly pagos: PagosService,
    private readonly mp: MercadoPagoService,
  ) {}

  /**
   * Webhook de Mercado Pago.
   * Validación doble: firma HMAC + consulta a la API de MP (en PagosService).
   * Responde 200 rápido; MP reintenta si devolvemos error.
   */
  @Post('mercadopago')
  @HttpCode(200)
  @SkipThrottle()
  async mercadopago(
    @Query('data.id') dataIdQuery: string | undefined,
    @Query('type') typeQuery: string | undefined,
    @Body() body: any,
    @Headers('x-signature') xSignature: string | undefined,
    @Headers('x-request-id') xRequestId: string | undefined,
  ) {
    const dataId: string | undefined = dataIdQuery ?? body?.data?.id;
    const tipo: string | undefined = typeQuery ?? body?.type;

    const firmaOk = this.mp.validarFirma({ xSignature, xRequestId, dataId });
    if (!firmaOk) {
      this.logger.warn('Webhook con firma inválida rechazado');
      throw new ForbiddenException('Firma inválida');
    }

    if (tipo !== 'payment' || !dataId) {
      return { recibido: true }; // otros eventos no nos interesan
    }

    // No bloquear la respuesta a MP: procesar y loguear errores aparte
    this.pagos
      .procesarNotificacionPago(String(dataId), body)
      .catch((e) => this.logger.error(`Error procesando pago ${dataId}: ${e}`));

    return { recibido: true };
  }
}
