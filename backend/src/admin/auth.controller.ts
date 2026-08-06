import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('admin/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Rate limit estricto contra fuerza bruta: 5 intentos por minuto. */
  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }
}
