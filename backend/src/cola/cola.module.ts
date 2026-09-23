import { Module } from '@nestjs/common';
import { CreditosModule } from '../creditos/creditos.module';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { SesionesModule } from '../sesiones/sesiones.module';
import { ShellyModule } from '../shelly/shelly.module';
import { SillasModule } from '../sillas/sillas.module';
import { ColaController } from './cola.controller';
import { ColaService } from './cola.service';

@Module({
  // SillasModule (Bloque C): ColaService invalida la cache de estado de
  // SillasService después de escribir `silla.estado` (LIBRE↔RESERVADA). Sin
  // ciclo: SillasModule solo importa ShellyModule.
  imports: [MercadoPagoModule, SesionesModule, ShellyModule, CreditosModule, SillasModule],
  controllers: [ColaController],
  providers: [ColaService],
  exports: [ColaService],
})
export class ColaModule {}
