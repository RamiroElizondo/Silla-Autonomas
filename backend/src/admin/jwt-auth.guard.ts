import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.service';

export interface RequestConUsuario extends Request {
  usuario?: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestConUsuario>();
    const header = req.headers.authorization ?? '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
      throw new UnauthorizedException('Token requerido');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    // Revocación (hallazgo MEDIO): si hubo logout (o cualquier otro
    // incremento de tokenVersion) después de que este token se firmó, el
    // token queda muerto aunque no haya expirado todavía.
    const usuario = await this.prisma.usuarioAdmin.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true },
    });
    if (!usuario || usuario.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    req.usuario = payload;
    return true;
  }
}
