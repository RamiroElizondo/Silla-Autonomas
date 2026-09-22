import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LIMITE_LOGIN } from '../common/throttle.config';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('admin/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Rate limit estricto contra fuerza bruta: ver throttle.config.ts. */
  @Post('login')
  @Throttle({ default: LIMITE_LOGIN })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }
}
