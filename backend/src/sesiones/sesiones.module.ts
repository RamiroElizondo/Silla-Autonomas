import { Module } from '@nestjs/common';
import { ShellyModule } from '../shelly/shelly.module';
import { SesionesService } from './sesiones.service';

@Module({
  imports: [ShellyModule],
  providers: [SesionesService],
  exports: [SesionesService],
})
export class SesionesModule {}
