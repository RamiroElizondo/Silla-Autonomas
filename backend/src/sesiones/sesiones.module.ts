import { Module } from '@nestjs/common';
import { CreditosModule } from '../creditos/creditos.module';
import { ShellyModule } from '../shelly/shelly.module';
import { EnergiaService } from './energia.service';
import { SesionesController } from './sesiones.controller';
import { SesionesService } from './sesiones.service';

@Module({
  imports: [ShellyModule, CreditosModule],
  controllers: [SesionesController],
  providers: [SesionesService, EnergiaService],
  exports: [SesionesService],
})
export class SesionesModule {}
