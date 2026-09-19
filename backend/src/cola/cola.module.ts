import { Module } from '@nestjs/common';
import { CreditosModule } from '../creditos/creditos.module';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { SesionesModule } from '../sesiones/sesiones.module';
import { ShellyModule } from '../shelly/shelly.module';
import { ColaController } from './cola.controller';
import { ColaService } from './cola.service';

@Module({
  imports: [MercadoPagoModule, SesionesModule, ShellyModule, CreditosModule],
  controllers: [ColaController],
  providers: [ColaService],
  exports: [ColaService],
})
export class ColaModule {}
