import { Module } from '@nestjs/common';
import { SillasController } from './sillas.controller';
import { SillasService } from './sillas.service';

@Module({
  controllers: [SillasController],
  providers: [SillasService],
  exports: [SillasService],
})
export class SillasModule {}
