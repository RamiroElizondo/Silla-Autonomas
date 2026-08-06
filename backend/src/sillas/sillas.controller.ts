import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { SillasService } from './sillas.service';

/** Endpoints públicos que consume la landing /silla/[id] y la pantalla TV. */
@Controller('sillas')
export class SillasController {
  constructor(private readonly sillas: SillasService) {}

  @Get(':id/estado')
  estado(@Param('id', ParseUUIDPipe) id: string) {
    return this.sillas.estadoPublico(id);
  }
}
