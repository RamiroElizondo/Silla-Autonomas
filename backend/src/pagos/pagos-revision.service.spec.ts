import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PagosService } from './pagos.service';

/**
 * Bloque B (hallazgo MEDIO): pagos aprobados que no activan ningún servicio
 * y transiciones a reembolso de pagos ya aprobados. Test harness separado de
 * pagos.service.spec.ts (que cubre iniciarCheckout) para no mezclar mocks.
 */
function crearServicio(overrides: {
  pago?: Partial<Record<string, jest.Mock>>;
  sesion?: Partial<Record<string, jest.Mock>>;
  turno?: Partial<Record<string, jest.Mock>>;
  esperarConfirmacion?: jest.Mock;
  procesarPagoAprobado?: jest.Mock;
  emitirCredito?: jest.Mock;
} = {}) {
  const prisma: any = {
    pago: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      // count: 0 por defecto — la mayoría de los tests simulan un pago nuevo
      // (INSERT vía `create`), no la reactivación de uno RECHAZADO previo.
      // Los tests de reembolso/resolución que sí dependen de `updateMany`
      // pisan este mock explícitamente.
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      ...overrides.pago,
    },
    sesion: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.sesion,
    },
    turno: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.turno,
    },
  };
  const mp: any = { obtenerPago: jest.fn() };
  const sesiones: any = {
    esperarConfirmacion: overrides.esperarConfirmacion ?? jest.fn().mockResolvedValue(undefined),
  };
  const sillas: any = {};
  const cola: any = {
    procesarPagoAprobado: overrides.procesarPagoAprobado ?? jest.fn().mockResolvedValue(undefined),
  };
  const turnstile: any = {};
  const ipHash: any = {};
  const creditos: any = { emitir: overrides.emitirCredito ?? jest.fn().mockResolvedValue({ id: 'credito-1' }) };
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
  return { servicio, prisma, mp, sesiones, cola, creditos };
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

const SESION_BASE = { id: 'sesion-1', monto: 1000, sillaId: 'silla-1' };
const TURNO_BASE = { id: 'turno-1', monto: 1000 };

describe('PagosService — pagos aprobados sin servicio (Bloque B)', () => {
  it('moneda distinta de ARS: no activa la sesión, marca requiereRevision con motivo moneda_no_ars', async () => {
    const { servicio, prisma, mp, sesiones } = crearServicio({
      sesion: { findUnique: jest.fn().mockResolvedValue(SESION_BASE) },
    });
    mp.obtenerPago.mockResolvedValue({
      id: 1,
      status: 'approved',
      transaction_amount: 1000,
      currency_id: 'USD',
      external_reference: 'ref-1',
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(sesiones.esperarConfirmacion).not.toHaveBeenCalled();
    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requiereRevision: true,
          motivoRevision: 'moneda_no_ars',
          estado: 'APROBADO',
        }),
      }),
    );
  });

  it('monto insuficiente: no activa la sesión, marca requiereRevision con motivo monto_insuficiente', async () => {
    const { servicio, prisma, sesiones, mp } = crearServicio({
      sesion: { findUnique: jest.fn().mockResolvedValue(SESION_BASE) },
    });
    mp.obtenerPago.mockResolvedValue({
      id: 1,
      status: 'approved',
      transaction_amount: 500,
      currency_id: 'ARS',
      external_reference: 'ref-1',
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(sesiones.esperarConfirmacion).not.toHaveBeenCalled();
    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiereRevision: true, motivoRevision: 'monto_insuficiente' }),
      }),
    );
  });

  it('pago aprobado y correcto: activa la sesión sin marcar revisión', async () => {
    const { servicio, prisma, sesiones, mp } = crearServicio({
      sesion: { findUnique: jest.fn().mockResolvedValue(SESION_BASE) },
    });
    mp.obtenerPago.mockResolvedValue({
      id: 1,
      status: 'approved',
      transaction_amount: 1000,
      currency_id: 'ARS',
      external_reference: 'ref-1',
    });

    await servicio.procesarNotificacionPago('pay-1', {});

    expect(sesiones.esperarConfirmacion).toHaveBeenCalledWith('sesion-1');
    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requiereRevision: false, motivoRevision: undefined }),
      }),
    );
  });

  it('sesión ya no pendiente al aplicar: marca requiereRevision con motivo sesion_no_pendiente', async () => {
    const esperarConfirmacion = jest.fn().mockRejectedValue(new ConflictException('no pendiente'));
    const { servicio, prisma, mp } = crearServicio({
      sesion: { findUnique: jest.fn().mockResolvedValue(SESION_BASE) },
      esperarConfirmacion,
    });
    mp.obtenerPago.mockResolvedValue({
      id: 1,
      status: 'approved',
      transaction_amount: 1000,
      currency_id: 'ARS',
      external_reference: 'ref-1',
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(prisma.pago.update).toHaveBeenCalledWith({
      where: { paymentIdMp: 'pay-1' },
      data: { requiereRevision: true, motivoRevision: 'sesion_no_pendiente' },
    });
  });

  it('turno ya no pendiente al aplicar: marca requiereRevision con motivo turno_no_pendiente', async () => {
    const procesarPagoAprobado = jest.fn().mockRejectedValue(new ConflictException('no pendiente'));
    const { servicio, prisma, mp } = crearServicio({
      turno: { findUnique: jest.fn().mockResolvedValue(TURNO_BASE) },
      procesarPagoAprobado,
    });
    mp.obtenerPago.mockResolvedValue({
      id: 1,
      status: 'approved',
      transaction_amount: 1000,
      currency_id: 'ARS',
      external_reference: 'ref-1',
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(prisma.pago.update).toHaveBeenCalledWith({
      where: { paymentIdMp: 'pay-1' },
      data: { requiereRevision: true, motivoRevision: 'turno_no_pendiente' },
    });
  });

  it('external_reference desconocido y aprobado: igual registra el pago con requiereRevision', async () => {
    const { servicio, prisma, mp } = crearServicio();
    mp.obtenerPago.mockResolvedValue({
      id: 1,
      status: 'approved',
      transaction_amount: 1000,
      currency_id: 'ARS',
      external_reference: 'ref-fantasma',
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(prisma.pago.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requiereRevision: true,
          motivoRevision: 'external_reference_desconocido',
        }),
      }),
    );
  });

  it('external_reference desconocido y NO aprobado: no crea registro (no hay plata en juego)', async () => {
    const { servicio, prisma, mp } = crearServicio();
    mp.obtenerPago.mockResolvedValue({
      id: 1,
      status: 'rejected',
      transaction_amount: 1000,
      currency_id: 'ARS',
      external_reference: 'ref-fantasma',
    });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(prisma.pago.create).not.toHaveBeenCalled();
  });
});

describe('PagosService — idempotencia y transición a reembolso (Bloque B)', () => {
  it('webhook duplicado con el mismo estado aprobado: no vuelve a tocar nada', async () => {
    const { servicio, prisma, mp, sesiones } = crearServicio({
      pago: { findUnique: jest.fn().mockResolvedValue({ estado: 'APROBADO', sesionId: 'sesion-1' }) },
    });
    mp.obtenerPago.mockResolvedValue({ id: 1, status: 'approved', transaction_amount: 1000, external_reference: 'ref-1' });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(prisma.pago.updateMany).not.toHaveBeenCalled();
    expect(sesiones.esperarConfirmacion).not.toHaveBeenCalled();
  });

  it('pago ya aprobado que MP marca refunded: pasa a REEMBOLSADO y no corta nada automáticamente', async () => {
    const { servicio, prisma, mp, sesiones, cola } = crearServicio({
      pago: {
        findUnique: jest.fn().mockResolvedValue({ estado: 'APROBADO', sesionId: 'sesion-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      sesion: { findUnique: jest.fn().mockResolvedValue({ estado: 'ACTIVA' }) },
    });
    mp.obtenerPago.mockResolvedValue({ id: 1, status: 'refunded', transaction_amount: 1000, external_reference: 'ref-1' });

    const s = silenciarLogger();
    await servicio.procesarNotificacionPago('pay-1', {});
    s.restore();

    expect(prisma.pago.updateMany).toHaveBeenCalledWith({
      where: { paymentIdMp: 'pay-1', estado: 'APROBADO' },
      data: { estado: 'REEMBOLSADO', requiereRevision: true, motivoRevision: 'pago_refunded' },
    });
    // No corta la corriente ni cancela nada por su cuenta.
    expect(sesiones.esperarConfirmacion).not.toHaveBeenCalled();
    expect(cola.procesarPagoAprobado).not.toHaveBeenCalled();
  });

  it('transición a reembolso es idempotente frente a notificaciones concurrentes', async () => {
    const { servicio, prisma, mp } = crearServicio({
      pago: {
        findUnique: jest.fn().mockResolvedValue({ estado: 'APROBADO', sesionId: null }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // otra ya lo hizo
      },
    });
    mp.obtenerPago.mockResolvedValue({ id: 1, status: 'charged_back', transaction_amount: 1000, external_reference: 'ref-1' });

    const s = silenciarLogger();
    await expect(servicio.procesarNotificacionPago('pay-1', {})).resolves.toBeUndefined();
    s.restore();

    expect(prisma.pago.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('PagosService.resolverPagoParaRevision (Bloque B)', () => {
  it('pago inexistente: NotFoundException', async () => {
    const { servicio } = crearServicio({ pago: { findUnique: jest.fn().mockResolvedValue(null) } });
    await expect(
      servicio.resolverPagoParaRevision('no-existe', { accion: 'ignorar' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pago que no requiere revisión: ConflictException', async () => {
    const { servicio } = crearServicio({
      pago: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', requiereRevision: false }) },
    });
    await expect(
      servicio.resolverPagoParaRevision('p1', { accion: 'ignorar' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('pago ya resuelto: no repite la acción, devuelve el pago tal cual', async () => {
    const pagoResuelto = { id: 'p1', requiereRevision: true, resueltoEn: new Date() };
    const { servicio, prisma, creditos } = crearServicio({
      pago: { findUnique: jest.fn().mockResolvedValue(pagoResuelto) },
    });

    const resultado = await servicio.resolverPagoParaRevision('p1', { accion: 'emitir_vale' });

    expect(resultado).toBe(pagoResuelto);
    expect(prisma.pago.updateMany).not.toHaveBeenCalled();
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('emitir_vale con sesión asociada: usa su duración y queda enlazado por sesionOrigenId', async () => {
    const pago = {
      id: 'p1',
      requiereRevision: true,
      resueltoEn: null,
      motivoRevision: 'monto_insuficiente',
      recibidoEn: new Date('2026-01-01'),
      sesion: { id: 'sesion-1', duracionMin: 10 },
      turno: null,
    };
    const { servicio, creditos, prisma } = crearServicio({
      pago: {
        findUnique: jest.fn().mockResolvedValue(pago),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    await servicio.resolverPagoParaRevision('p1', { accion: 'emitir_vale' });

    expect(creditos.emitir).toHaveBeenCalledWith(
      expect.objectContaining({ duracionMin: 10, sesionOrigenId: 'sesion-1' }),
    );
    expect(prisma.pago.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', resueltoEn: null },
      data: expect.objectContaining({ resolucion: 'VALE_EMITIDO', estado: undefined }),
    });
  });

  it('emitir_vale con turno (sin sesión): usa su duración, sin sesionOrigenId (limitación conocida)', async () => {
    const pago = {
      id: 'p1',
      requiereRevision: true,
      resueltoEn: null,
      motivoRevision: 'turno_no_pendiente',
      recibidoEn: new Date('2026-01-01'),
      sesion: null,
      turno: { id: 'turno-1', duracionMin: 15 },
    };
    const { servicio, creditos } = crearServicio({
      pago: {
        findUnique: jest.fn().mockResolvedValue(pago),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    await servicio.resolverPagoParaRevision('p1', { accion: 'emitir_vale' });

    expect(creditos.emitir).toHaveBeenCalledWith(
      expect.objectContaining({ duracionMin: 15, sesionOrigenId: undefined }),
    );
  });

  it('emitir_vale sin sesión ni turno y sin duracionMinVale: BadRequestException', async () => {
    const pago = {
      id: 'p1',
      requiereRevision: true,
      resueltoEn: null,
      sesion: null,
      turno: null,
    };
    const { servicio, creditos } = crearServicio({
      pago: { findUnique: jest.fn().mockResolvedValue(pago) },
    });

    await expect(
      servicio.resolverPagoParaRevision('p1', { accion: 'emitir_vale' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('marcar_reembolsado: pasa estado a REEMBOLSADO (se excluye de ingresos) y no emite vale', async () => {
    const pago = { id: 'p1', requiereRevision: true, resueltoEn: null, sesion: null, turno: null };
    const { servicio, prisma, creditos } = crearServicio({
      pago: {
        findUnique: jest.fn().mockResolvedValue(pago),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    await servicio.resolverPagoParaRevision('p1', { accion: 'marcar_reembolsado' });

    expect(prisma.pago.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', resueltoEn: null },
      data: expect.objectContaining({ resolucion: 'REEMBOLSADO_MANUAL', estado: 'REEMBOLSADO' }),
    });
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('ignorar: no cambia el estado del pago ni emite vale', async () => {
    const pago = { id: 'p1', requiereRevision: true, resueltoEn: null, estado: 'APROBADO', sesion: null, turno: null };
    const { servicio, prisma, creditos } = crearServicio({
      pago: {
        findUnique: jest.fn().mockResolvedValue(pago),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    await servicio.resolverPagoParaRevision('p1', { accion: 'ignorar' });

    expect(prisma.pago.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', resueltoEn: null },
      data: expect.objectContaining({ resolucion: 'IGNORADO', estado: 'APROBADO' }),
    });
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('doble click concurrente: si otro pedido ya lo resolvió, no vuelve a emitir el vale', async () => {
    const pago = {
      id: 'p1',
      requiereRevision: true,
      resueltoEn: null,
      sesion: { id: 'sesion-1', duracionMin: 10 },
      turno: null,
    };
    const { servicio, creditos } = crearServicio({
      pago: {
        findUnique: jest.fn().mockResolvedValue(pago),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await servicio.resolverPagoParaRevision('p1', { accion: 'emitir_vale' });

    expect(creditos.emitir).not.toHaveBeenCalled();
  });
});

describe('PagosService.listarPagosParaRevision (Bloque B)', () => {
  it('pide solo los pendientes de resolver, más recientes primero', async () => {
    const { servicio, prisma } = crearServicio();
    await servicio.listarPagosParaRevision(25);

    expect(prisma.pago.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requiereRevision: true, resueltoEn: null },
        take: 25,
        orderBy: { recibidoEn: 'desc' },
      }),
    );
  });
});
