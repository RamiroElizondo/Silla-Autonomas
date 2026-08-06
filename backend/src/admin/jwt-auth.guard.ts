import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
      throw new UnauthorizedException('Token requerido');
    }
    try {
      (req as any).usuario = await this.jwt.verifyAsync(token);
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
