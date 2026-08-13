import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ColaService } from './cola.service';
import { UnirseColaDto } from './dto/unirse-cola.dto';

/** Endpoints públicos de la cola compartida entre todas las sillas del local. */
@Controller('cola')
export class ColaController {
  constructor(private readonly cola: ColaService) {}

  /** Resumen para mostrar en la landing de una silla ocupada. */
  @Get('estado')
  estadoResumen() {
    return this.cola.estadoResumen();
  }

  /** El cliente toca "Pagar y esperar mi turno". */
  @Post('checkout')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  checkout(@Body() dto: UnirseColaDto) {
    return this.cola.unirse(dto.origin);
  }

  /** Estado puntual de un turno (polling desde /cola/[turnoId]). */
  @Get(':id/estado')
  estadoTurno(@Param('id', ParseUUIDPipe) id: string) {
    return this.cola.estadoTurno(id);
  }

  /** El cliente cancela/abandona el checkout de MP y vuelve a `/cola/:id/fracaso`. */
  @Post(':id/cancelar')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async cancelar(@Param('id', ParseUUIDPipe) id: string) {
    await this.cola.expirarEsperaPago(id);
    return { ok: true };
  }

  /** El cliente confirma presencia cuando le toca la silla asignada. */
  @Post(':id/confirmar')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  confirmar(@Param('id', ParseUUIDPipe) id: string) {
    return this.cola.confirmar(id);
  }
}
