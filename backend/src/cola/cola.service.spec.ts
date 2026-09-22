import { ForbiddenException, HttpException } from '@nestjs/common';
import { ColaService } from './cola.service';

function crearServicio(
  opciones: {
    turnstileOk?: boolean;
    pendientesPorHash?: Record<string, number>;
    creditoTomar?: jest.Mock;
  } = {},
) {
  const pendientesPorHash = opciones.pendientesPorHash ?? {};

  const prisma: any = {
    silla: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'silla-1', precio: 1000, duracionMin: 10 },
      ]),
    },
    turno: {
      create: jest.fn((args) => Promise.resolve({ id: 'turno-1', ...args.data })),
      count: jest.fn((args) => Promise.resolve(pendientesPorHash[args.where.ipHash] ?? 0)),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    sesion: { count: jest.fn().mockResolvedValue(0) },
    credito: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const mp: any = {
    crearPreferencia: jest.fn().mockResolvedValue({ id: 'p1', initPoint: 'https://mp.test/turno' }),
  };
  const sesiones: any = {};
  const heartbeat: any = { estaOffline: jest.fn().mockReturnValue(false) };
  const creditos: any = {
    tomar:
      opciones.creditoTomar ??
      jest.fn().mockResolvedValue({ id: 'credito-1', codigo: 'LUZ-AAAA-BBBB', duracionMin: 10, prioridadDesde: new Date() }),
    vincularTurno: jest.fn().mockResolvedValue(undefined),
  };
  const fallosCanje: any = {
    verificarNoBloqueado: jest.fn(),
    registrarExito: jest.fn(),
    registrarFallo: jest.fn(),
  };
  const turnstile: any = {
    verificar: jest.fn().mockResolvedValue({ ok: opciones.turnstileOk ?? true }),
  };
  const ipHash: any = { hash: jest.fn((ip: string) => `hash:${ip}`) };
  const config: any = { get: () => '' };

  const servicio = new ColaService(
    prisma,
    mp,
    sesiones,
    heartbeat,
    creditos,
    fallosCanje,
    turnstile,
    ipHash,
    config,
  );
  return { servicio, prisma, mp, turnstile, ipHash, creditos, fallosCanje };
}

describe('ColaService.unirse — Turnstile y tope por IP (Hallazgo ALTO 2)', () => {
  // unirse() programa un timer real (setTimeout) de varios minutos para
  // expirar la espera de pago. Con timers reales, ese handle mantiene vivo
  // el proceso de Jest hasta que el timer efectivamente vence. Con fake
  // timers, jest.useFakeTimers() lo intercepta sin afectar las promesas que
  // sí esperamos (mp.crearPreferencia, prisma.*).
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('si Turnstile falla, no crea el turno ni llama a Mercado Pago', async () => {
    const { servicio, prisma, mp } = crearServicio({ turnstileOk: false });

    await expect(
      servicio.unirse(undefined, 'token-malo', '1.2.3.4'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.turno.create).not.toHaveBeenCalled();
    expect(mp.crearPreferencia).not.toHaveBeenCalled();
  });

  it('con el tope de pendientes alcanzado para esa IP, rechaza con 429', async () => {
    const { servicio, prisma } = crearServicio({
      pendientesPorHash: { 'hash:1.2.3.4': 3 },
    });

    await expect(
      servicio.unirse(undefined, 'token-ok', '1.2.3.4'),
    ).rejects.toBeInstanceOf(HttpException);

    expect(prisma.turno.create).not.toHaveBeenCalled();
  });

  it('con Turnstile ok y cupo libre, crea el turno con el ip_hash', async () => {
    const { servicio, prisma } = crearServicio({ pendientesPorHash: {} });

    await servicio.unirse(undefined, 'token-ok', '1.2.3.4');

    expect(prisma.turno.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ipHash: 'hash:1.2.3.4' }),
      }),
    );
  });
});

describe('ColaService.canjearCredito — freno de fuerza bruta (Hallazgo ALTO 3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('si la IP está bloqueada, no llega ni a intentar el canje', async () => {
    const { servicio, creditos, fallosCanje } = crearServicio();
    fallosCanje.verificarNoBloqueado.mockImplementation(() => {
      throw new HttpException('bloqueada', 429);
    });

    await expect(
      servicio.canjearCredito('LUZ-0000', '1.2.3.4'),
    ).rejects.toBeInstanceOf(HttpException);

    expect(creditos.tomar).not.toHaveBeenCalled();
  });

  it('código inválido: registra el fallo para esa IP y propaga la excepción', async () => {
    const creditoTomar = jest.fn().mockRejectedValue(new Error('código inválido'));
    const { servicio, fallosCanje } = crearServicio({ creditoTomar });

    await expect(
      servicio.canjearCredito('LUZ-0000', '1.2.3.4'),
    ).rejects.toThrow('código inválido');

    expect(fallosCanje.registrarFallo).toHaveBeenCalledWith('1.2.3.4');
    expect(fallosCanje.registrarExito).not.toHaveBeenCalled();
  });

  it('código válido: registra el éxito (limpia el historial de fallos) y crea el turno', async () => {
    const { servicio, fallosCanje, creditos, prisma } = crearServicio();

    const resultado = await servicio.canjearCredito('LUZ-AAAA-BBBB', '1.2.3.4');

    expect(fallosCanje.registrarExito).toHaveBeenCalledWith('1.2.3.4');
    expect(fallosCanje.registrarFallo).not.toHaveBeenCalled();
    expect(creditos.vincularTurno).toHaveBeenCalledWith('credito-1', 'turno-1');
    expect(prisma.turno.create).toHaveBeenCalled();
    expect(resultado.turnoId).toBe('turno-1');
  });
});
