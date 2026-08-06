import { Module } from '@nestjs/common';
import { SesionesModule } from '../sesiones/sesiones.module';
import { SillasModule } from '../sillas/sillas.module';
import { MercadoPagoService } from './mercadopago.service';
import { PagosController } from './pagos.controller';
import { PagosService } from './pagos.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [SesionesModule, SillasModule],
  controllers: [PagosController, WebhooksController],
  providers: [PagosService, MercadoPagoService],
})
export class PagosModule {}
