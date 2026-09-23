import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LIMITE_LOGIN } from '../common/throttle.config';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard, type RequestConUsuario } from './jwt-auth.guard';

@Controller('admin/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Rate limit estricto contra fuerza bruta por IP: ver throttle.config.ts.
   * El bloqueo por cuenta (independiente del de IP) vive en AuthService.
   */
  @Post('login')
  @Throttle({ default: LIMITE_LOGIN })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /**
   * El frontend (y el proxy, indirectamente) usan esto para saber si la
   * cookie de sesión todavía corresponde a un token válido y no revocado.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: RequestConUsuario) {
    return this.auth.me(req.usuario!.sub);
  }

  /**
   * Invalida todos los tokens emitidos hasta ahora (tokenVersion++). El
   * proxy del frontend borra la cookie aparte, sea cual sea el resultado.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Req() req: RequestConUsuario) {
    await this.auth.logout(req.usuario!.sub);
    return { ok: true };
  }
}
