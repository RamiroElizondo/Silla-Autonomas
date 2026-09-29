import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PagosService } from './pagos.service';

function crearServicio(
  opciones: {
    turnstileOk?: boolean;
    pendientesPorHash?: Record<string, number>;
    crearPreferencia?: jest.Mock;
    obtenerPago?: jest.Mock;
    esperarConfirmacion?: jest.Mock;
    procesarPagoAprobado?: jest.Mock;
    expirarPagoPendiente?: jest.Mock;
    prismaSesion?: Partial<Record<string, jest.Mock>>;
    prismaTurno?: Partial<Record<string, jest.Mock>>;
    prismaPago?: Partial<Record<string, jest.Mock>>;
  } = {},
) {
  const pendientesPorHash = opciones.pendientesPorHash ?? {};

  const prisma: any = {
    sesion: {
      count: jest.fn((args) => Promise.resolve(pendientesPorHash[args.where.ipHash] ?? 0)),
      findUnique: jest.fn().mockResolvedValue(null),
      ...opciones.prismaSesion,
    },
    turno: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      ...opciones.prismaTurno,
    },
    pago: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      ...opciones.prismaPago,
    },
  };
  const mp: any = {
    crearPreferencia:
      opciones.crearPreferencia ??
      jest.fn().mockResolvedValue({ id: 'p1', initPoint: 'https://mp.test/pagar' }),
    obtenerPago: opciones.obtenerPago ?? jest.fn().mockResolvedValue(null),
  };
  const sesiones: any = {
    crearSesionPendiente: jest.fn().mockResolvedValue({ id: 'sesion-1' }),
    expirarPagoPendiente: opciones.expirarPagoPendiente ?? jest.fn(),
    esperarConfirmacion: opciones.esperarConfirmacion ?? jest.fn().mockResolvedValue(undefined),
  };
  const sillas: any = {
    obtener: jest.fn().mockResolvedValue({
      id: 'silla-1',
      nombre: 'Silla 1',
      precio: 1000,
      duracionMin: 10,
    }),
  };
  const cola: any = {
    procesarPagoAprobado: opciones.procesarPagoAprobado ?? jest.fn().mockResolvedValue(undefined),
  };
  const turnstile: any = {
    verificar: jest.fn().mockResolvedValue({ ok: opciones.turnstileOk ?? true }),
  };
  // Hash "de mentira" para el test: devuelve la IP tal cual con un prefijo,
  // así el mock de prisma.sesion.count puede simularse por IP.
  const ipHash: any = { hash: jest.fn((ip: string) => `hash:${ip}`) };
  const creditos: any = { emitir: jest.fn().mockResolvedValue({ id: 'credito-1', codigo: 'LUZ-0001' }) };
  const config: any = { get: () => '' };

  const servicio = new PagosService(
    prisma,
    mp,
    sesiones,
    sillas,
    cola,
    turnstile,
    ipHash,
    creditos,
    config,
  );
  return { servicio, prisma, mp, sesiones, sillas, cola, turnstile, ipHash, creditos };
}

function silenciarLogger() {
  const { Logger } = require('@nestjs/common');
  const spies = {
    log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  };
  return { ...spies, restore: () => Object.values(spies).forEach((s) => s.mockRestore()) };
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

describe('PagosService.iniciarCheckout — falla de Mercado Pago al crear la preferencia', () => {
  it('si mp.crearPreferencia tira, libera la silla (expirarPagoPendiente) y relanza el error original', async () => {
    const errorMp = new Error('Mercado Pago no responde');
    const crearPreferencia = jest.fn().mockRejectedValue(errorMp);
    const { servicio, sesiones } = crearServicio({ crearPreferencia });

    await expect(
      servicio.iniciarCheckout('silla-1', undefined, 'token-ok', '1.2.3.4'),
    ).rejects.toBe(errorMp);

    expect(sesiones.expirarPagoPendiente).toHaveBeenCalledWith('sesion-1');
  });
});

describe('PagosService.cancelarCheckout', () => {
  it('sesión inexistente: devuelve { ok: false } sin liberar nada', async () => {
    const { servicio, sesiones } = crearServicio({
      prismaSesion: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    const resultado = await servicio.cancelarCheckout('silla-1', 'sesion-x');

    expect(resultado).toEqual({ ok: false });
    expect(sesiones.expirarPagoPendiente).not.toHaveBeenCalled();
  });

  it('la sesión existe pero pertenece a otra silla: devuelve { ok: false } sin liberar nada', async () => {
    const { servicio, sesiones } = crearServicio({
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', sillaId: 'silla-OTRA' }),
      },
    });

    const resultado = await servicio.cancelarCheckout('silla-1', 'sesion-1');

    expect(resultado).toEqual({ ok: false });
    expect(sesiones.expirarPagoPendiente).not.toHaveBeenCalled();
  });

  it('sesión válida de esta silla: libera (expirarPagoPendiente) y devuelve { ok: true }', async () => {
    const { servicio, sesiones } = crearServicio({
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', sillaId: 'silla-1' }),
      },
    });

    const resultado = await servicio.cancelarCheckout('silla-1', 'sesion-1');

    expect(resultado).toEqual({ ok: true });
    expect(sesiones.expirarPagoPendiente).toHaveBeenCalledWith('sesion-1');
  });
});

describe('PagosService.confirmarRetornoSilla', () => {
  it('MP no encuentra el pago (null): NotFoundException', async () => {
    const { servicio } = crearServicio({ obtenerPago: jest.fn().mockResolvedValue(null) });

    await expect(servicio.confirmarRetornoSilla('silla-1', 'pay-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el pago de MP no trae external_reference: NotFoundException', async () => {
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({ status: 'approved', external_reference: null }),
    });

    await expect(servicio.confirmarRetornoSilla('silla-1', 'pay-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el pago todavía no está aprobado: ConflictException con el status en el mensaje', async () => {
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'in_process',
        external_reference: 'ref-1',
      }),
    });

    await expect(servicio.confirmarRetornoSilla('silla-1', 'pay-1')).rejects.toThrow(/in_process/);
  });

  it('external_reference no corresponde a ninguna sesión: NotFoundException', async () => {
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-fantasma',
        transaction_amount: 1000,
      }),
      prismaSesion: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    await expect(servicio.confirmarRetornoSilla('silla-1', 'pay-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('la sesión encontrada pertenece a otra silla: NotFoundException', async () => {
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
      }),
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', sillaId: 'silla-OTRA' }),
      },
    });

    await expect(servicio.confirmarRetornoSilla('silla-1', 'pay-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('pago válido: procesa el pago, la sesión queda ACTIVA y devuelve { ok: true }', async () => {
    // El mismo mock atiende las dos formas en que confirmarRetornoSilla /
    // procesarPagoVerificado consultan `sesion.findUnique`: por
    // externalReference (para ubicar la sesión) y por id (para el chequeo
    // final de estado).
    const findUnique = jest.fn((args: any) => {
      if (args.where.externalReference) {
        return Promise.resolve({ id: 'sesion-1', sillaId: 'silla-1', monto: 1000 });
      }
      if (args.where.id) {
        return Promise.resolve({ estado: 'ACTIVA' });
      }
      return Promise.resolve(null);
    });
    const { servicio, sesiones } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaSesion: { findUnique },
    });

    const resultado = await servicio.confirmarRetornoSilla('silla-1', 'pay-1');

    expect(resultado).toEqual({ ok: true });
    expect(sesiones.esperarConfirmacion).toHaveBeenCalledWith('sesion-1');
  });

  it('el pago se aprobó pero la sesión no quedó ACTIVA tras procesar: ConflictException ("ya venció")', async () => {
    const findUnique = jest.fn((args: any) => {
      if (args.where.externalReference) {
        return Promise.resolve({ id: 'sesion-1', sillaId: 'silla-1', monto: 1000 });
      }
      if (args.where.id) {
        return Promise.resolve({ estado: 'CANCELADA' });
      }
      return Promise.resolve(null);
    });
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaSesion: { findUnique },
    });

    await expect(servicio.confirmarRetornoSilla('silla-1', 'pay-1')).rejects.toThrow(/venció/);
  });
});

describe('PagosService.confirmarRetornoTurno', () => {
  it('MP no encuentra el pago (null): NotFoundException', async () => {
    const { servicio } = crearServicio({ obtenerPago: jest.fn().mockResolvedValue(null) });

    await expect(servicio.confirmarRetornoTurno('turno-1', 'pay-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el pago todavía no está aprobado: ConflictException con el status en el mensaje', async () => {
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({ status: 'pending', external_reference: 'ref-1' }),
    });

    await expect(servicio.confirmarRetornoTurno('turno-1', 'pay-1')).rejects.toThrow(/pending/);
  });

  it('external_reference no corresponde a ningún turno: NotFoundException', async () => {
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-fantasma',
        transaction_amount: 1000,
      }),
      prismaTurno: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    await expect(servicio.confirmarRetornoTurno('turno-1', 'pay-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el turno encontrado no coincide con el turnoId pedido: NotFoundException', async () => {
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
      }),
      prismaTurno: { findUnique: jest.fn().mockResolvedValue({ id: 'turno-OTRO' }) },
    });

    await expect(servicio.confirmarRetornoTurno('turno-1', 'pay-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('pago válido: procesa el pago, el turno queda anotado y devuelve { ok: true }', async () => {
    const findUnique = jest.fn((args: any) => {
      if (args.where.externalReference) {
        return Promise.resolve({ id: 'turno-1', monto: 1000 });
      }
      if (args.where.id) {
        return Promise.resolve({ estado: 'EN_COLA' });
      }
      return Promise.resolve(null);
    });
    const { servicio, cola } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaTurno: { findUnique },
    });

    const resultado = await servicio.confirmarRetornoTurno('turno-1', 'pay-1');

    expect(resultado).toEqual({ ok: true });
    expect(cola.procesarPagoAprobado).toHaveBeenCalledWith('turno-1');
  });

  it('el pago se aprobó pero el turno quedó ESPERANDO_PAGO/CANCELADA: ConflictException ("ya venció")', async () => {
    const findUnique = jest.fn((args: any) => {
      if (args.where.externalReference) {
        return Promise.resolve({ id: 'turno-1', monto: 1000 });
      }
      if (args.where.id) {
        return Promise.resolve({ estado: 'CANCELADA' });
      }
      return Promise.resolve(null);
    });
    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaTurno: { findUnique },
    });

    await expect(servicio.confirmarRetornoTurno('turno-1', 'pay-1')).rejects.toThrow(/venció/);
  });
});

describe('PagosService.procesarNotificacionPago — pago no encontrado en MP', () => {
  it('si MP no devuelve el pago, no busca sesión/turno ni escribe nada', async () => {
    const { servicio, prisma } = crearServicio({ obtenerPago: jest.fn().mockResolvedValue(null) });

    const s = silenciarLogger();
    await expect(servicio.procesarNotificacionPago('pay-1', {})).resolves.toBeUndefined();
    s.restore();

    expect(prisma.pago.findUnique).not.toHaveBeenCalled();
    expect(prisma.sesion.findUnique).not.toHaveBeenCalled();
    expect(prisma.turno.findUnique).not.toHaveBeenCalled();
  });
});

describe('PagosService.procesarNotificacionPago — external_reference vacío', () => {
  it('pago sin external_reference: no busca sesión ni turno, no crea registro', async () => {
    const { servicio, prisma } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: null,
        transaction_amount: 1000,
      }),
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(prisma.sesion.findUnique).not.toHaveBeenCalled();
    expect(prisma.turno.findUnique).not.toHaveBeenCalled();
    expect(prisma.pago.create).not.toHaveBeenCalled();
  });
});

describe('PagosService.procesarNotificacionPago — pago rechazado no activa nada', () => {
  it('sesión encontrada pero pago rechazado: registra RECHAZADO y no activa la sesión', async () => {
    const { servicio, sesiones, prisma } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'rejected',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', monto: 1000 }),
      },
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(sesiones.esperarConfirmacion).not.toHaveBeenCalled();
    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'RECHAZADO' }) }),
    );
  });

  it('turno encontrado pero pago rechazado: registra RECHAZADO y no anota en cola', async () => {
    const { servicio, cola, prisma } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'rejected',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaTurno: {
        findUnique: jest.fn().mockResolvedValue({ id: 'turno-1', monto: 1000 }),
      },
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(cola.procesarPagoAprobado).not.toHaveBeenCalled();
    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'RECHAZADO' }) }),
    );
  });
});

describe('PagosService.procesarNotificacionPago — errores de infraestructura no se tragan', () => {
  it('si sesiones.esperarConfirmacion tira un error que no es ConflictException, se relanza tal cual', async () => {
    const errorInfra = new Error('DB caída');
    const { servicio, prisma } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', monto: 1000 }),
      },
      esperarConfirmacion: jest.fn().mockRejectedValue(errorInfra),
    });

    const s = silenciarLogger();
    await expect(servicio.procesarNotificacionPago('pay-1', {})).rejects.toBe(errorInfra);
    s.restore();

    // No lo confunde con "sesión ya no pendiente": no marca para revisión.
    expect(prisma.pago.update).not.toHaveBeenCalled();
  });

  it('si cola.procesarPagoAprobado tira un error que no es ConflictException, se relanza tal cual', async () => {
    const errorInfra = new Error('DB caída');
    const { servicio, prisma } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaTurno: {
        findUnique: jest.fn().mockResolvedValue({ id: 'turno-1', monto: 1000 }),
      },
      procesarPagoAprobado: jest.fn().mockRejectedValue(errorInfra),
    });

    const s = silenciarLogger();
    await expect(servicio.procesarNotificacionPago('pay-1', {})).rejects.toBe(errorInfra);
    s.restore();

    expect(prisma.pago.update).not.toHaveBeenCalled();
  });
});

describe('PagosService.procesarNotificacionPago — turno: revisión requerida y camino feliz', () => {
  it('monto insuficiente en pago de turno: no anota en cola, marca requiereRevision', async () => {
    const { servicio, cola, prisma } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 500,
        currency_id: 'ARS',
      }),
      prismaTurno: {
        findUnique: jest.fn().mockResolvedValue({ id: 'turno-1', monto: 1000 }),
      },
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(cola.procesarPagoAprobado).not.toHaveBeenCalled();
    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requiereRevision: true,
          motivoRevision: 'monto_insuficiente',
        }),
      }),
    );
  });

  it('pago de turno aprobado y correcto: anota en la cola sin marcar revisión', async () => {
    const { servicio, cola, prisma } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaTurno: {
        findUnique: jest.fn().mockResolvedValue({ id: 'turno-1', monto: 1000 }),
      },
    });

    await servicio.procesarNotificacionPago('pay-1', {});

    expect(cola.procesarPagoAprobado).toHaveBeenCalledWith('turno-1');
    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiereRevision: false, motivoRevision: undefined }),
      }),
    );
  });
});

describe('PagosService — registrarEstadoPago: colisión concurrente en payment_id_mp (P2002)', () => {
  it('el create choca con P2002 (unique paymentIdMp): no aplica el pago y no revienta', async () => {
    const err: any = new Error('unique constraint failed');
    err.code = 'P2002';
    Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);

    const { servicio, sesiones } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', monto: 1000 }),
      },
      prismaPago: {
        create: jest.fn().mockRejectedValue(err),
      },
    });

    const s = silenciarLogger();
    await expect(servicio.procesarNotificacionPago('pay-1', {})).resolves.toBeUndefined();
    s.restore();

    expect(sesiones.esperarConfirmacion).not.toHaveBeenCalled();
  });

  it('el create falla con un error que no es de Prisma: se relanza tal cual', async () => {
    const errorRaro = new Error('disco lleno');

    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', monto: 1000 }),
      },
      prismaPago: {
        create: jest.fn().mockRejectedValue(errorRaro),
      },
    });

    const s = silenciarLogger();
    await expect(servicio.procesarNotificacionPago('pay-1', {})).rejects.toBe(errorRaro);
    s.restore();
  });

  it('el create falla con un error de Prisma con código distinto de P2002: se relanza tal cual', async () => {
    const err: any = new Error('foreign key violation');
    err.code = 'P2003';
    Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);

    const { servicio } = crearServicio({
      obtenerPago: jest.fn().mockResolvedValue({
        status: 'approved',
        external_reference: 'ref-1',
        transaction_amount: 1000,
        currency_id: 'ARS',
      }),
      prismaSesion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sesion-1', monto: 1000 }),
      },
      prismaPago: {
        create: jest.fn().mockRejectedValue(err),
      },
    });

    const s = silenciarLogger();
    await expect(servicio.procesarNotificacionPago('pay-1', {})).rejects.toBe(err);
    s.restore();
  });
});
