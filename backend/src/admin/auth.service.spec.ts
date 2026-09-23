import { HttpException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { LoginBloqueoService } from './login-bloqueo.service';

function crearPrismaMock(usuario: Record<string, unknown> | null) {
  return {
    usuarioAdmin: {
      findUnique: jest.fn().mockResolvedValue(usuario),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function crearJwtMock() {
  return { signAsync: jest.fn().mockResolvedValue('jwt-firmado') };
}

describe('AuthService', () => {
  const PASSWORD = 'password-correcta';
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4); // cost bajo: más rápido en tests
  });

  it('login exitoso: firma el token con tokenVersion, actualiza ultimoLogin y limpia el bloqueo', async () => {
    const usuario = {
      id: 'u1',
      email: 'admin@local.com',
      passwordHash: hash,
      tokenVersion: 3,
    };
    const prisma = crearPrismaMock(usuario);
    const jwt = crearJwtMock();
    const bloqueo = new LoginBloqueoService();
    jest.spyOn(bloqueo, 'registrarExito');

    const service = new AuthService(prisma as any, jwt as any, bloqueo);
    const resultado = await service.login('admin@local.com', PASSWORD);

    expect(resultado).toEqual({ token: 'jwt-firmado' });
    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: 'u1',
      email: 'admin@local.com',
      tokenVersion: 3,
    });
    expect(prisma.usuarioAdmin.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { ultimoLogin: expect.any(Date) },
    });
    expect(bloqueo.registrarExito).toHaveBeenCalledWith('admin@local.com');
  });

  it('contraseña incorrecta: 401 y cuenta como fallo', async () => {
    const usuario = { id: 'u1', email: 'admin@local.com', passwordHash: hash, tokenVersion: 0 };
    const prisma = crearPrismaMock(usuario);
    const bloqueo = new LoginBloqueoService();
    jest.spyOn(bloqueo, 'registrarFallo');
    const service = new AuthService(prisma as any, crearJwtMock() as any, bloqueo);

    await expect(service.login('admin@local.com', 'mala')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(bloqueo.registrarFallo).toHaveBeenCalledWith('admin@local.com');
  });

  it('email inexistente: mismo error 401 (no revela si el email existe) y cuenta como fallo', async () => {
    const prisma = crearPrismaMock(null);
    const bloqueo = new LoginBloqueoService();
    jest.spyOn(bloqueo, 'registrarFallo');
    const service = new AuthService(prisma as any, crearJwtMock() as any, bloqueo);

    await expect(
      service.login('no-existe@local.com', 'lo-que-sea'),
    ).rejects.toThrow(UnauthorizedException);
    expect(bloqueo.registrarFallo).toHaveBeenCalledWith('no-existe@local.com');
  });

  it('email bloqueado: 429 genérico, ni siquiera consulta la base', async () => {
    const prisma = crearPrismaMock(null);
    const bloqueo = new LoginBloqueoService();
    jest.spyOn(bloqueo, 'estaBloqueado').mockReturnValue(true);
    const service = new AuthService(prisma as any, crearJwtMock() as any, bloqueo);

    await expect(service.login('a@a.com', 'x')).rejects.toThrow(HttpException);
    expect(prisma.usuarioAdmin.findUnique).not.toHaveBeenCalled();
  });

  it('logout: incrementa tokenVersion del usuario', async () => {
    const prisma = crearPrismaMock(null);
    const service = new AuthService(prisma as any, crearJwtMock() as any, new LoginBloqueoService());

    await service.logout('u1');

    expect(prisma.usuarioAdmin.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { tokenVersion: { increment: 1 } },
    });
  });

  it('me: devuelve id/email si el usuario existe', async () => {
    const prisma = crearPrismaMock({ id: 'u1', email: 'a@a.com' });
    const service = new AuthService(prisma as any, crearJwtMock() as any, new LoginBloqueoService());

    await expect(service.me('u1')).resolves.toEqual({ id: 'u1', email: 'a@a.com' });
  });

  it('me: 401 si el usuario ya no existe', async () => {
    const prisma = crearPrismaMock(null);
    const service = new AuthService(prisma as any, crearJwtMock() as any, new LoginBloqueoService());

    await expect(service.me('borrado')).rejects.toThrow(UnauthorizedException);
  });
});
