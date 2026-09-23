import { Module } from '@nestjs/common';
import { ColaModule } from '../cola/cola.module';
import { CreditosModule } from '../creditos/creditos.module';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { SesionesModule } from '../sesiones/sesiones.module';
import { SillasModule } from '../sillas/sillas.module';
import { PagosController } from './pagos.controller';
import { PagosService } from './pagos.service';
import { RetornosController } from './retornos.controller';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [SesionesModule, SillasModule, MercadoPagoModule, ColaModule, CreditosModule],
  controllers: [PagosController, RetornosController, WebhooksController],
  providers: [PagosService],
  // Bloque B: AdminModule usa PagosService para /admin/pagos/revision.
  exports: [PagosService],
})
export class PagosModule {}
