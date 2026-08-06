import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const usuario = await this.prisma.usuarioAdmin.findUnique({
      where: { email },
    });
    // Comparar siempre contra un hash para no filtrar si el email existe
    const hash =
      usuario?.passwordHash ??
      '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(password, hash);

    if (!usuario || !ok) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    await this.prisma.usuarioAdmin.update({
      where: { id: usuario.id },
      data: { ultimoLogin: new Date() },
    });

    const token = await this.jwt.signAsync({
      sub: usuario.id,
      email: usuario.email,
    });
    return { token };
  }
}
