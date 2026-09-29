import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LIMITE_CONFIRMACION, LIMITE_ESTADO } from '../common/throttle.config';
import { SesionesService } from './sesiones.service';

/**
 * Endpoint público de la sesión propia del cliente. La landing sondea el
 * estado de la SILLA, que alcanza mientras todo sale bien; esto es lo que le
 * permite al cliente enterarse de un corte y de su crédito aunque la silla ya
 * haya vuelto a estar libre para otro.
 */
@Controller('sesiones')
export class SesionesController {
  constructor(private readonly sesiones: SesionesService) {}

  @Get(':id/estado')
  @Throttle({ default: LIMITE_ESTADO })
  estado(@Param('id', ParseUUIDPipe) id: string) {
    return this.sesiones.estadoPublico(id);
  }

  /** El cliente confirma que se sentó: enciende la silla que pagó. */
  @Post(':id/confirmar')
  @Throttle({ default: LIMITE_CONFIRMACION })
  confirmar(@Param('id', ParseUUIDPipe) id: string) {
    return this.sesiones.confirmarSesion(id);
  }
}
