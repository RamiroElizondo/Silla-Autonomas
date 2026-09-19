import { Module } from '@nestjs/common';
import { ShellyModule } from '../shelly/shelly.module';
import { SillasController } from './sillas.controller';
import { SillasService } from './sillas.service';

@Module({
  imports: [ShellyModule],
  controllers: [SillasController],
  providers: [SillasService],
  exports: [SillasService],
})
export class SillasModule {}
