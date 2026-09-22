import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LIMITE_CONFIRMACION } from '../common/throttle.config';
import { ConfirmarRetornoDto } from './dto/confirmar-retorno.dto';
import { PagosService } from './pagos.service';

/**
 * Respaldo para el retorno de Checkout Pro. Nunca confía en los parámetros
 * del navegador: PagosService vuelve a consultar el pago a Mercado Pago.
 */
@Controller()
export class RetornosController {
  constructor(private readonly pagos: PagosService) {}

  @Post('sillas/:id/confirmar-pago')
  @Throttle({ default: LIMITE_CONFIRMACION })
  confirmarSilla(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarRetornoDto,
  ) {
    return this.pagos.confirmarRetornoSilla(id, dto.paymentId);
  }

  @Post('cola/:id/confirmar-pago')
  @Throttle({ default: LIMITE_CONFIRMACION })
  confirmarTurno(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarRetornoDto,
  ) {
    return this.pagos.confirmarRetornoTurno(id, dto.paymentId);
  }
}
