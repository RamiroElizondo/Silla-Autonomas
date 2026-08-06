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
import { SesionesService } from '../sesiones/sesiones.service';
import { HeartbeatService } from '../shelly/heartbeat.service';
import { ShellyService } from '../shelly/shelly.service';
import { AdminService } from './admin.service';
import { ActivarManualDto, ActualizarSillaDto } from './dto/actualizar-silla.dto';
import { CrearSillaDto } from './dto/crear-silla.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly sesiones: SesionesService,
    private readonly heartbeat: HeartbeatService,
    private readonly shelly: ShellyService,
  ) {}

  /**
   * Lista los Shelly de la cuenta cloud con modelo y generación detectados.
   * Para el alta de sillas: elegir el device de acá, sin tipear IDs.
   */
  @Get('shelly/dispositivos')
  dispositivos() {
    return this.shelly.listarDispositivos();
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

  @Get('sesiones')
  historial(
    @Query('take', new DefaultValuePipe(50), ParseIntPipe) take: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
  ) {
    return this.admin.sesiones(Math.min(take, 200), skip);
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
}
