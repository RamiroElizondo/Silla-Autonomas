import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PagosService } from '../pagos/pagos.service';
import { ResolverPagoDto } from '../pagos/dto/resolver-pago.dto';
import { SesionesService } from '../sesiones/sesiones.service';
import { HeartbeatService } from '../shelly/heartbeat.service';
import { AdminService } from './admin.service';
import { ActivarManualDto, ActualizarSillaDto } from './dto/actualizar-silla.dto';
import { CrearSillaDto } from './dto/crear-silla.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ParseIntMinPipe } from '../common/parse-int-min.pipe';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly sesiones: SesionesService,
    private readonly heartbeat: HeartbeatService,
    private readonly pagos: PagosService,
  ) {}

  /**
   * Verifica un device Shelly puntual (existe / online / modelo / generación).
   * La Cloud Control API v2 no permite listar los dispositivos de la cuenta,
   * así que el alta de sillas se hace ingresando el ID y validándolo acá.
   */
  @Get('shelly/dispositivos/:deviceId')
  verificarDispositivo(@Param('deviceId') deviceId: string) {
    return this.admin.consultarDispositivo(deviceId);
  }

  @Get('sillas')
  sillas() {
    return this.admin.sillas();
  }

  /** Alta de silla: valida que el device exista y esté online antes de crear. */
  @Post('sillas')
  crearSilla(@Body() dto: CrearSillaDto) {
    return this.admin.crearSilla(dto);
  }

  /** Prueba de conexión con el Shelly de la silla (estado en el momento). */
  @Get('sillas/:id/probar')
  probar(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.probarSilla(id);
  }

  /** Clientes que pagaron y esperan silla (o tienen una asignada sin confirmar). */
  @Get('cola')
  cola() {
    return this.admin.cola();
  }

  @Get('sesiones')
  historial(
    @Query('take', new DefaultValuePipe(50), ParseIntPipe, new ParseIntMinPipe(1)) take: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe, new ParseIntMinPipe(0)) skip: number,
  ) {
    return this.admin.sesiones(Math.min(take, 200), skip);
  }

  /** Vales por cortes de energía: cuáles se emitieron y cuáles se usaron. */
  @Get('creditos')
  creditos(
    @Query('take', new DefaultValuePipe(50), ParseIntPipe, new ParseIntMinPipe(1)) take: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe, new ParseIntMinPipe(0)) skip: number,
  ) {
    return this.admin.listarCreditos(Math.min(take, 200), skip);
  }

  @Get('metricas')
  metricas() {
    return this.admin.metricas();
  }

  @Get('salud')
  salud() {
    return this.heartbeat.getSalud();
  }

  @Patch('sillas/:id')
  actualizarSilla(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarSillaDto,
  ) {
    return this.admin.actualizarSilla(id, dto);
  }

  /** Activación manual (cortesía, prueba, cliente que pagó en efectivo). */
  @Post('sillas/:id/activar')
  activar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActivarManualDto,
  ) {
    return this.sesiones.activarManual(id, dto.duracionMin);
  }

  /** Parada de emergencia: corta la corriente ya. */
  @Post('sillas/:id/detener')
  detener(@Param('id', ParseUUIDPipe) id: string) {
    return this.sesiones.detenerEmergencia(id);
  }

  /**
   * Pagos aprobados que no llegaron a activar ningún servicio, o que
   * Mercado Pago marcó refunded/charged_back/cancelled después de haber
   * sido aprobados (Bloque B, hallazgo MEDIO). Solo los pendientes de
   * resolver.
   */
  @Get('pagos/revision')
  pagosParaRevision(
    @Query('take', new DefaultValuePipe(50), ParseIntPipe, new ParseIntMinPipe(1)) take: number,
  ) {
    return this.pagos.listarPagosParaRevision(Math.min(take, 200));
  }

  /** Resuelve a mano un pago marcado para revisión. Idempotente. */
  @Post('pagos/:id/resolver')
  resolverPago(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolverPagoDto,
  ) {
    return this.pagos.resolverPagoParaRevision(id, dto);
  }
}
