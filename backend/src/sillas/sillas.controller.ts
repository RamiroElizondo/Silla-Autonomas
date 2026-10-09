import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LIMITE_ESTADO } from '../common/throttle.config';
import { SillasService } from './sillas.service';

/** Endpoints públicos que consume la landing /silla/[id] y la pantalla TV (/pantalla). */
@Controller('sillas')
export class SillasController {
  constructor(private readonly sillas: SillasService) {}

  /**
   * Estado de todos los sillones del local, para la pantalla TV única. Un
   * solo request cada pocos segundos en vez de uno por sillón.
   */
  @Get('estado')
  @Throttle({ default: LIMITE_ESTADO })
  estadoDeTodas() {
    return this.sillas.estadosPublicos();
  }

  @Get(':id/estado')
  @Throttle({ default: LIMITE_ESTADO })
  estado(@Param('id', ParseUUIDPipe) id: string) {
    return this.sillas.estadoPublico(id);
  }
}
