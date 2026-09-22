import { Module } from '@nestjs/common';
import { CreditosService } from './creditos.service';
import { FallosCanjeService } from './fallos-canje.service';

@Module({
  providers: [CreditosService, FallosCanjeService],
  exports: [CreditosService, FallosCanjeService],
})
export class CreditosModule {}
