import { Module } from '@nestjs/common';
import { CreditosService } from './creditos.service';

@Module({
  providers: [CreditosService],
  exports: [CreditosService],
})
export class CreditosModule {}
