import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextoConHeader(authorization?: string): ExecutionContext {
  const req: any = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function crearGuard(opts: {
  verify?: () => Promise<any>;
  usuario?: { tokenVersion: number } | null;
}) {
  const jwt = {
    verifyAsync: opts.verify ?? jest.fn().mockResolvedValue({ sub: 'u1', tokenVersion: 1 }),
  };
  // 'usuario' in opts, no `??`: `null` es un valor válido a propósito
  // ("no existe en la base"), distinto de "no lo pasé" (default).
  const usuario = 'usuario' in opts ? opts.usuario : { tokenVersion: 1 };
  const prisma = {
    usuarioAdmin: {
      findUnique: jest.fn().mockResolvedValue(usuario),
    },
  };
  return { guard: new JwtAuthGuard(jwt as any, prisma as any), jwt, prisma };
}

describe('JwtAuthGuard', () => {
  it('sin header Authorization: 401', async () => {
    const { guard } = crearGuard({});
    await expect(guard.canActivate(contextoConHeader())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('header sin "Bearer": 401', async () => {
    const { guard } = crearGuard({});
    await expect(
      guard.canActivate(contextoConHeader('Basic algo')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('token inválido o expirado (jwt.verifyAsync tira): 401', async () => {
    const { guard } = crearGuard({
      verify: jest.fn().mockRejectedValue(new Error('jwt expired')),
    });
    await expect(
      guard.canActivate(contextoConHeader('Bearer expirado')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('token válido y tokenVersion vigente: pasa y adjunta el usuario a la request', async () => {
    const { guard } = crearGuard({ usuario: { tokenVersion: 1 } });
    const ctx = contextoConHeader('Bearer valido');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).usuario).toEqual({
      sub: 'u1',
      tokenVersion: 1,
    });
  });

  it('tokenVersion del token no coincide con la de la base (revocado por logout): 401', async () => {
    const { guard } = crearGuard({ usuario: { tokenVersion: 2 } });
    await expect(
      guard.canActivate(contextoConHeader('Bearer viejo')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('el usuario ya no existe en la base: 401', async () => {
    const { guard } = crearGuard({ usuario: null });
    await expect(
      guard.canActivate(contextoConHeader('Bearer valido')),
    ).rejects.toThrow(UnauthorizedException);
  });
});
