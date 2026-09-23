import { Module } from '@nestjs/common';
import { CreditosModule } from '../creditos/creditos.module';
import { ShellyModule } from '../shelly/shelly.module';
import { SillasModule } from '../sillas/sillas.module';
import { EnergiaService } from './energia.service';
import { SesionesController } from './sesiones.controller';
import { SesionesService } from './sesiones.service';

@Module({
  // SillasModule (Bloque C): SesionesService invalida la cache de estado de
  // SillasService después de cualquier escritura que cambie `silla.estado` o
  // `silla.finSesionActual`. Sin ciclo: SillasModule solo importa
  // ShellyModule, nunca depende de SesionesModule.
  imports: [ShellyModule, CreditosModule, SillasModule],
  controllers: [SesionesController],
  providers: [SesionesService, EnergiaService],
  exports: [SesionesService],
})
export class SesionesModule {}
