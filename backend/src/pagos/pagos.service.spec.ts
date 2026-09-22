import { ForbiddenException, HttpException } from '@nestjs/common';
import { PagosService } from './pagos.service';

function crearServicio(
  opciones: {
    turnstileOk?: boolean;
    pendientesPorHash?: Record<string, number>;
  } = {},
) {
  const pendientesPorHash = opciones.pendientesPorHash ?? {};

  const prisma: any = {
    sesion: {
      count: jest.fn((args) => Promise.resolve(pendientesPorHash[args.where.ipHash] ?? 0)),
    },
    turno: { count: jest.fn().mockResolvedValue(0) },
  };
  const mp: any = {
    crearPreferencia: jest.fn().mockResolvedValue({ id: 'p1', initPoint: 'https://mp.test/pagar' }),
  };
  const sesiones: any = {
    crearSesionPendiente: jest.fn().mockResolvedValue({ id: 'sesion-1' }),
    expirarPagoPendiente: jest.fn(),
  };
  const sillas: any = {
    obtener: jest.fn().mockResolvedValue({
      id: 'silla-1',
      nombre: 'Silla 1',
      precio: 1000,
      duracionMin: 10,
    }),
  };
  const cola: any = {};
  const turnstile: any = {
    verificar: jest.fn().mockResolvedValue({ ok: opciones.turnstileOk ?? true }),
  };
  // Hash "de mentira" para el test: devuelve la IP tal cual con un prefijo,
  // así el mock de prisma.sesion.count puede simularse por IP.
  const ipHash: any = { hash: jest.fn((ip: string) => `hash:${ip}`) };
  const config: any = { get: () => '' };

  const servicio = new PagosService(prisma, mp, sesiones, sillas, cola, turnstile, ipHash, config);
  return { servicio, prisma, mp, sesiones, sillas, turnstile, ipHash };
}

describe('PagosService.iniciarCheckout — Turnstile y tope por IP (Hallazgo ALTO 2)', () => {
  it('si Turnstile falla, no reserva la silla ni llama a Mercado Pago', async () => {
    const { servicio, sesiones, mp } = crearServicio({ turnstileOk: false });

    await expect(
      servicio.iniciarCheckout('silla-1', undefined, 'token-malo', '1.2.3.4'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(sesiones.crearSesionPendiente).not.toHaveBeenCalled();
    expect(mp.crearPreferencia).not.toHaveBeenCalled();
  });

  it('con 3 reservas pendientes ya en esa IP (el tope), la 4.ª se rechaza con 429', async () => {
    const { servicio, sesiones, mp } = crearServicio({
      pendientesPorHash: { 'hash:1.2.3.4': 3 },
    });

    await expect(
      servicio.iniciarCheckout('silla-1', undefined, 'token-ok', '1.2.3.4'),
    ).rejects.toBeInstanceOf(HttpException);

    expect(sesiones.crearSesionPendiente).not.toHaveBeenCalled();
    expect(mp.crearPreferencia).not.toHaveBeenCalled();
  });

  it('una IP distinta con cupo libre no se ve afectada por el tope de otra', async () => {
    const { servicio, sesiones } = crearServicio({
      pendientesPorHash: { 'hash:1.2.3.4': 3 },
    });

    await servicio.iniciarCheckout('silla-1', undefined, 'token-ok', '9.9.9.9');

    expect(sesiones.crearSesionPendiente).toHaveBeenCalled();
  });

  it('con Turnstile ok y cupo libre, reserva y crea la preferencia normalmente', async () => {
    const { servicio, sesiones, mp } = crearServicio({
      pendientesPorHash: { 'hash:1.2.3.4': 2 },
    });

    const resultado = await servicio.iniciarCheckout('silla-1', undefined, 'token-ok', '1.2.3.4');

    expect(sesiones.crearSesionPendiente).toHaveBeenCalled();
    expect(mp.crearPreferencia).toHaveBeenCalled();
    expect(resultado.initPoint).toBe('https://mp.test/pagar');
  });

  it('nunca loguea la IP real en claro', async () => {
    const { Logger } = require('@nestjs/common');
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { servicio } = crearServicio({ pendientesPorHash: {} });
    await servicio.iniciarCheckout('silla-1', undefined, 'token-ok', '203.0.113.99');

    const textosLogueados = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .filter((v): v is string => typeof v === 'string');
    expect(textosLogueados.some((t) => t.includes('203.0.113.99'))).toBe(false);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
