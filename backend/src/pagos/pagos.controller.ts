import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CancelarPagoDto } from './dto/cancelar-pago.dto';
import { CheckoutDto } from './dto/checkout.dto';
import { PagosService } from './pagos.service';

@Controller('sillas')
export class PagosController {
  constructor(private readonly pagos: PagosService) {}

  /**
   * El cliente toca "Pagar" en la landing.
   * Devuelve { sesionId, initPoint } para redirigir a Checkout Pro.
   */
  @Post(':id/checkout')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  checkout(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckoutDto) {
    return this.pagos.iniciarCheckout(id, dto.origin);
  }

  /**
   * El cliente cancela/abandona el checkout de MP y vuelve a `/fracaso`.
   * Libera la silla al instante en vez de esperar el timeout de 3 min.
   * Best-effort: si la sesión ya no está PENDIENTE (ya se activó, ya expiró),
   * no hace nada — es idempotente.
   */
  @Post(':id/cancelar-pago')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  cancelarPago(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelarPagoDto) {
    return this.pagos.cancelarCheckout(id, dto.sesionId);
  }
}
