import { Module } from '@nestjs/common';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { SesionesModule } from '../sesiones/sesiones.module';
import { ColaController } from './cola.controller';
import { ColaService } from './cola.service';

@Module({
  imports: [MercadoPagoModule, SesionesModule],
  controllers: [ColaController],
  providers: [ColaService],
  exports: [ColaService],
})
export class ColaModule {}
