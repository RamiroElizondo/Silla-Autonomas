import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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
  checkout(@Param('id', ParseUUIDPipe) id: string) {
    return this.pagos.iniciarCheckout(id);
  }
}
