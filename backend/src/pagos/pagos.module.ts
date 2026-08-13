import { Module } from '@nestjs/common';
import { ColaModule } from '../cola/cola.module';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { SesionesModule } from '../sesiones/sesiones.module';
import { SillasModule } from '../sillas/sillas.module';
import { PagosController } from './pagos.controller';
import { PagosService } from './pagos.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [SesionesModule, SillasModule, MercadoPagoModule, ColaModule],
  controllers: [PagosController, WebhooksController],
  providers: [PagosService],
})
export class PagosModule {}
