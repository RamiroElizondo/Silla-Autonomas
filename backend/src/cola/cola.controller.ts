import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { resolverIpConfiable } from '../common/client-ip.util';
import {
  LIMITE_CANJEAR,
  LIMITE_CHECKOUT,
  LIMITE_CONFIRMACION,
  LIMITE_ESTADO,
} from '../common/throttle.config';
import { ColaService } from './cola.service';
import { CanjearCreditoDto } from './dto/canjear-credito.dto';
import { UnirseColaDto } from './dto/unirse-cola.dto';

/** Endpoints públicos de la cola compartida entre todas las sillas del local. */
@Controller('cola')
export class ColaController {
  constructor(private readonly cola: ColaService) {}

  /** Resumen para mostrar en la landing de una silla ocupada. */
  @Get('estado')
  @Throttle({ default: LIMITE_ESTADO })
  estadoResumen() {
    return this.cola.estadoResumen();
  }

  /** El cliente toca "Pagar y esperar mi turno". */
  @Post('checkout')
  @Throttle({ default: LIMITE_CHECKOUT })
  checkout(@Body() dto: UnirseColaDto, @Req() req: Request) {
    const ipCliente = resolverIpConfiable(req);
    return this.cola.unirse(
      dto.origin,
      dto.turnstileToken,
      ipCliente,
      dto.opcion,
      dto.sillaId,
    );
  }

  /**
   * El cliente canjea un vale (corte de energía) y vuelve a la cola sin
   * pagar. Límite bajo a propósito: el código es corto y no queremos que
   * nadie lo adivine a fuerza de intentos (ver también FallosCanjeService).
   */
  @Post('canjear')
  @Throttle({ default: LIMITE_CANJEAR })
  canjear(@Body() dto: CanjearCreditoDto, @Req() req: Request) {
    const ipCliente = resolverIpConfiable(req);
    return this.cola.canjearCredito(dto.codigo, ipCliente);
  }

  /** Estado puntual de un turno (polling desde /cola/[turnoId]). */
  @Get(':id/estado')
  @Throttle({ default: LIMITE_ESTADO })
  estadoTurno(@Param('id', ParseUUIDPipe) id: string) {
    return this.cola.estadoTurno(id);
  }

  /** El cliente cancela/abandona el checkout de MP y vuelve a `/cola/:id/fracaso`. */
  @Post(':id/cancelar')
  @Throttle({ default: LIMITE_CONFIRMACION })
  async cancelar(@Param('id', ParseUUIDPipe) id: string) {
    await this.cola.expirarEsperaPago(id);
    return { ok: true };
  }

  /** El cliente confirma presencia cuando le toca la silla asignada. */
  @Post(':id/confirmar')
  @Throttle({ default: LIMITE_CONFIRMACION })
  confirmar(@Param('id', ParseUUIDPipe) id: string) {
    return this.cola.confirmar(id);
  }
}
