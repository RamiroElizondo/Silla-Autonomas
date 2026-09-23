import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoginBloqueoService } from './login-bloqueo.service';

const MENSAJE_BLOQUEO =
  'Demasiados intentos fallidos. Probá de nuevo en unos minutos.';

export interface JwtPayload {
  sub: string;
  email: string;
  tokenVersion: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly bloqueo: LoginBloqueoService,
  ) {}

  async login(email: string, password: string): Promise<{ token: string }> {
    // Bloqueo por cuenta (hallazgo MEDIO): se chequea ANTES de tocar la
    // base, con el mismo status/mensaje genérico que un fallo de
    // credenciales — no hay forma de distinguir "bloqueado" de "contraseña
    // incorrecta" desde afuera.
    if (this.bloqueo.estaBloqueado(email)) {
      throw new HttpException(MENSAJE_BLOQUEO, HttpStatus.TOO_MANY_REQUESTS);
    }

    const usuario = await this.prisma.usuarioAdmin.findUnique({
      where: { email },
    });
    // Comparar siempre contra un hash para no filtrar si el email existe
    const hash =
      usuario?.passwordHash ??
      '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(password, hash);

    if (!usuario || !ok) {
      // Se cuenta también contra emails inexistentes (ver LoginBloqueoService).
      this.bloqueo.registrarFallo(email);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    this.bloqueo.registrarExito(email);

    await this.prisma.usuarioAdmin.update({
      where: { id: usuario.id },
      data: { ultimoLogin: new Date() },
    });

    const token = await this.jwt.signAsync({
      sub: usuario.id,
      email: usuario.email,
      tokenVersion: usuario.tokenVersion,
    } satisfies JwtPayload);
    return { token };
  }

  async me(usuarioId: string): Promise<{ id: string; email: string }> {
    const usuario = await this.prisma.usuarioAdmin.findUnique({
      where: { id: usuarioId },
      select: { id: true, email: true },
    });
    if (!usuario) throw new UnauthorizedException('Token inválido o expirado');
    return usuario;
  }

  /**
   * Invalida todos los tokens emitidos hasta ahora para este usuario
   * (hallazgo MEDIO: revocación). El JwtAuthGuard compara `tokenVersion`
   * del token contra la base en cada request.
   */
  async logout(usuarioId: string): Promise<void> {
    await this.prisma.usuarioAdmin.update({
      where: { id: usuarioId },
      data: { tokenVersion: { increment: 1 } },
    });
  }
}
