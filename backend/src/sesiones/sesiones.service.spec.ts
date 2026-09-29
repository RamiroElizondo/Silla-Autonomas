import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  GRACIA_REINICIO_SEG,
  MARGEN_AUTO_OFF_SEG,
  MAX_ESPERA_ENERGIA_SEG,
  RESTO_DESPRECIABLE_SEG,
  SesionesService,
  TIMEOUT_PAGO_MIN,
} from './sesiones.service';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function crearServicio() {
  const prisma: any = {
    sesion: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn((args: any) => Promise.resolve({ id: args.where.id, ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    silla: {
      findUnique: jest.fn(),
      update: jest.fn((args: any) => Promise.resolve({ id: args.where.id, ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    turno: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const shelly: any = { setRele: jest.fn().mockResolvedValue(undefined) };
  const heartbeat: any = { estaOffline: jest.fn().mockReturnValue(false) };
  const creditos: any = {
    porSesion: jest.fn().mockResolvedValue(null),
    emitir: jest.fn(),
  };
  const sillas: any = { invalidarCache: jest.fn() };

  const servicio = new SesionesService(prisma, shelly, heartbeat, creditos, sillas);
  return { servicio, prisma, shelly, heartbeat, creditos, sillas };
}

const filaBase = {
  id: 'sesion-1',
  estado: 'ACTIVA' as const,
  finProgramado: new Date(Date.now() + 5 * 60_000),
  interrumpidaEn: null,
  cortes: 0,
  segundosCompensados: 0,
  motivoCierre: null,
  duracionMin: 10,
  sillaId: 'silla-1',
  esManual: false,
  pagadaEn: null,
  creadaEn: new Date(),
  inicio: new Date(),
  silla: { id: 'silla-1', nombre: 'Silla 1', deviceIdShelly: 'dev-1' },
};

describe('SesionesService.estadoPublico — cache TTL de estado (Bloque C)', () => {
  it('dos llamadas dentro del TTL solo pegan una vez a la base por la sesión', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(filaBase);

    await servicio.estadoPublico('sesion-1');
    await servicio.estadoPublico('sesion-1');

    expect(prisma.sesion.findUnique).toHaveBeenCalledTimes(1);
  });

  it('segundosRestantes se recalcula en vivo aunque la fila venga de la cache', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(filaBase);

    const primero = await servicio.estadoPublico('sesion-1');
    const ahoraReal = Date.now;
    jest.spyOn(Date, 'now').mockReturnValue(ahoraReal() + 10_000);
    try {
      const segundo = await servicio.estadoPublico('sesion-1');
      expect(segundo.segundosRestantes).toBeLessThan(primero.segundosRestantes!);
    } finally {
      jest.spyOn(Date, 'now').mockRestore();
    }
  });

  it('el crédito de la sesión NUNCA se sirve de una cache: se consulta en cada llamada', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(filaBase);

    await servicio.estadoPublico('sesion-1');
    await servicio.estadoPublico('sesion-1');

    // La fila de sesión se cachea (una sola llamada a findUnique arriba),
    // pero porSesion() es tan barato (findFirst por columna indexada) que se
    // deja siempre en vivo — ver el comentario en estadoPublico().
    expect(creditos.porSesion).toHaveBeenCalledTimes(2);
  });
});

describe('SesionesService.estadoPublico — casos adicionales', () => {
  it('lanza NotFoundException si la sesión no existe', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(null);

    await expect(servicio.estadoPublico('sesion-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('segundosRestantes es null si la sesión no está ACTIVA', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, estado: 'COMPLETADA' });

    const resultado = await servicio.estadoPublico('sesion-1');

    expect(resultado.segundosRestantes).toBeNull();
  });

  it('segundosRestantes es null durante un corte en curso, aunque la sesión siga ACTIVA', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, interrumpidaEn: new Date() });

    const resultado = await servicio.estadoPublico('sesion-1');

    expect(resultado.segundosRestantes).toBeNull();
    expect(resultado.interrumpida).toBe(true);
  });

  it('incluye el crédito de la sesión cuando existe', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, estado: 'CANCELADA' });
    creditos.porSesion.mockResolvedValue({
      codigo: 'LUZ-1234',
      duracionMin: 5,
      estado: 'DISPONIBLE',
      venceEn: new Date('2026-06-01T00:00:00.000Z'),
    });

    const resultado = await servicio.estadoPublico('sesion-1');

    expect(resultado.credito).toEqual({
      codigo: 'LUZ-1234',
      duracionMin: 5,
      estado: 'DISPONIBLE',
      venceEn: new Date('2026-06-01T00:00:00.000Z'),
    });
  });
});

describe('SesionesService — invalidación explícita al cambiar estado (Bloque C)', () => {
  it('crearSesionPendiente invalida la cache de SillasService de la silla reservada', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.sesion.create.mockResolvedValue({ id: 'sesion-nueva' });

    await servicio.crearSesionPendiente(
      { id: 'silla-1', nombre: 'Silla 1', precio: 1000, duracionMin: 10 } as any,
      'ext-ref',
    );

    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
  });

  it('activarSesion invalida su propia cache de estado y la de SillasService', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, estado: 'PENDIENTE' });
    const invalidarPropia = jest.spyOn(servicio, 'invalidarCache');

    await servicio.activarSesion('sesion-1');

    expect(invalidarPropia).toHaveBeenCalledWith('sesion-1');
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
  });

  it('expirarPagoPendiente invalida su propia cache y la de SillasService', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, sillaId: 'silla-1' });
    const invalidarPropia = jest.spyOn(servicio, 'invalidarCache');

    await servicio.expirarPagoPendiente('sesion-1');

    expect(invalidarPropia).toHaveBeenCalledWith('sesion-1');
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
  });

  it('finalizarSesion invalida la cache: un sondeo justo después ya no ve el ACTIVA cacheado', async () => {
    const { servicio, prisma, sillas } = crearServicio();

    const activa = { ...filaBase };
    const completada = { ...filaBase, estado: 'COMPLETADA' as const, finProgramado: null };

    // Orden real de llamadas: (1) estadoPublico cachea la fila ACTIVA,
    // (2) finalizarSesion la relee para la lógica de apagado del relé,
    // (3), tras invalidar, estadoPublico vuelve a pegarle a la base.
    prisma.sesion.findUnique
      .mockResolvedValueOnce(activa)
      .mockResolvedValueOnce(activa)
      .mockResolvedValueOnce(completada);

    const primerSondeo = await servicio.estadoPublico('sesion-1');
    expect(primerSondeo.estado).toBe('ACTIVA');

    await servicio.finalizarSesion('sesion-1', 'tiempo_cumplido');

    const segundoSondeo = await servicio.estadoPublico('sesion-1');
    expect(segundoSondeo.estado).toBe('COMPLETADA');
    expect(prisma.sesion.findUnique).toHaveBeenCalledTimes(3);
    // La silla liberada también invalida su propia cache de estado.
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
  });
});

describe('SesionesService.onApplicationBootstrap — recuperación tras reinicio', () => {
  function mockFindManyPorEstado(prisma: any, filas: Record<string, any[]>) {
    prisma.sesion.findMany.mockImplementation((args: any) =>
      Promise.resolve(filas[args.where.estado] ?? []),
    );
  }

  it('sesión ACTIVA con un corte en curso: no la toca, la deja para EnergiaService', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    const activaConCorte = { ...filaBase, interrumpidaEn: new Date() };
    mockFindManyPorEstado(prisma, { ACTIVA: [activaConCorte] });

    await servicio.onApplicationBootstrap();

    expect(shelly.setRele).not.toHaveBeenCalled();
    expect(prisma.sesion.updateMany).not.toHaveBeenCalled();
  });

  it('sesión ACTIVA sin corte que ya venció durante el reinicio: la finaliza de una', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    const vencida = {
      ...filaBase,
      finProgramado: new Date(Date.now() - 1000),
      interrumpidaEn: null,
    };
    mockFindManyPorEstado(prisma, { ACTIVA: [vencida] });
    prisma.sesion.findUnique.mockResolvedValue(vencida);

    await servicio.onApplicationBootstrap();

    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', false);
    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ motivoCierre: 'completada_tras_reinicio' }),
      }),
    );
  });

  it('sesión ACTIVA sin corte que todavía tiene tiempo: reprograma el apagado', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    const vigente = {
      ...filaBase,
      finProgramado: new Date(Date.now() + 5 * 60_000),
      interrumpidaEn: null,
    };
    mockFindManyPorEstado(prisma, { ACTIVA: [vigente] });
    prisma.sesion.findUnique.mockResolvedValue(vigente);

    await servicio.onApplicationBootstrap();
    expect(shelly.setRele).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', false);
  });

  it('sesión ESPERANDO_ENERGIA cuyo límite de espera ya pasó: la vence de una', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const vencida = {
      ...filaBase,
      estado: 'ESPERANDO_ENERGIA',
      pagadaEn: new Date(Date.now() - (MAX_ESPERA_ENERGIA_SEG + 60) * 1000),
    };
    mockFindManyPorEstado(prisma, { ESPERANDO_ENERGIA: [vencida] });
    prisma.sesion.findUnique.mockResolvedValue(vencida);

    await servicio.onApplicationBootstrap();

    expect(creditos.emitir).toHaveBeenCalled();
  });

  it('sesión ESPERANDO_ENERGIA con tiempo restante: reprograma el vencimiento', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const conTiempo = { ...filaBase, estado: 'ESPERANDO_ENERGIA', pagadaEn: new Date() };
    mockFindManyPorEstado(prisma, { ESPERANDO_ENERGIA: [conTiempo] });
    prisma.sesion.findUnique.mockResolvedValue(conTiempo);

    await servicio.onApplicationBootstrap();
    expect(creditos.emitir).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(MAX_ESPERA_ENERGIA_SEG * 1000);

    expect(creditos.emitir).toHaveBeenCalled();
  });

  it('sesión PENDIENTE cuyo límite de pago ya pasó: expira de una', async () => {
    const { servicio, prisma } = crearServicio();
    const vencida = {
      ...filaBase,
      estado: 'PENDIENTE',
      creadaEn: new Date(Date.now() - (TIMEOUT_PAGO_MIN * 60_000 + 1000)),
    };
    mockFindManyPorEstado(prisma, { PENDIENTE: [vencida] });
    prisma.sesion.findUnique.mockResolvedValue(vencida);

    await servicio.onApplicationBootstrap();

    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: vencida.id, estado: 'PENDIENTE' }),
      }),
    );
  });

  it('sesión ACTIVA sin finProgramado (inconsistencia defensiva): la trata como vencida ya', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    const sinFin = { ...filaBase, finProgramado: null, interrumpidaEn: null };
    mockFindManyPorEstado(prisma, { ACTIVA: [sinFin] });
    prisma.sesion.findUnique.mockResolvedValue(sinFin);

    await servicio.onApplicationBootstrap();

    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', false);
  });

  it('sesión ESPERANDO_ENERGIA sin pagadaEn: usa creadaEn como referencia del límite de espera', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const sinPagadaEn = {
      ...filaBase,
      estado: 'ESPERANDO_ENERGIA',
      pagadaEn: null,
      creadaEn: new Date(Date.now() - (MAX_ESPERA_ENERGIA_SEG + 60) * 1000),
    };
    mockFindManyPorEstado(prisma, { ESPERANDO_ENERGIA: [sinPagadaEn] });
    prisma.sesion.findUnique.mockResolvedValue(sinPagadaEn);

    await servicio.onApplicationBootstrap();

    expect(creditos.emitir).toHaveBeenCalled();
  });

  it('sesión PENDIENTE con tiempo restante: reprograma la expiración', async () => {
    const { servicio, prisma } = crearServicio();
    const conTiempo = { ...filaBase, estado: 'PENDIENTE', creadaEn: new Date() };
    mockFindManyPorEstado(prisma, { PENDIENTE: [conTiempo] });
    prisma.sesion.findUnique.mockResolvedValue(conTiempo);

    await servicio.onApplicationBootstrap();
    expect(prisma.sesion.updateMany).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TIMEOUT_PAGO_MIN * 60_000);

    expect(prisma.sesion.updateMany).toHaveBeenCalled();
  });
});

describe('SesionesService.crearSesionPendiente — casos adicionales', () => {
  const silla = { id: 'silla-1', nombre: 'Silla 1', precio: 1500, duracionMin: 10 } as any;

  it('rechaza si el heartbeat marca la silla offline: no cobra lo que no puede entregar', async () => {
    const { servicio, heartbeat, prisma } = crearServicio();
    heartbeat.estaOffline.mockReturnValue(true);

    await expect(servicio.crearSesionPendiente(silla, 'ext-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.silla.updateMany).not.toHaveBeenCalled();
    expect(prisma.sesion.create).not.toHaveBeenCalled();
  });

  it('rechaza si otro cliente ya reservó la silla (pierde la carrera del updateMany)', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.silla.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(servicio.crearSesionPendiente(silla, 'ext-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.sesion.create).not.toHaveBeenCalled();
  });

  it('crea la sesión con el monto, la duración de la silla y el ipHash recibido', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.create.mockResolvedValue({ id: 'sesion-nueva' });

    await servicio.crearSesionPendiente(silla, 'ext-1', 'hash-ip');

    expect(prisma.sesion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sillaId: 'silla-1',
          externalReference: 'ext-1',
          monto: 1500,
          duracionMin: 10,
          ipHash: 'hash-ip',
        }),
      }),
    );
  });

  it('si el pago no llega en TIMEOUT_PAGO_MIN, expira sola y libera la silla', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.sesion.create.mockResolvedValue({ id: 'sesion-nueva' });
    prisma.sesion.findUnique.mockResolvedValue({ id: 'sesion-nueva', sillaId: 'silla-1' });

    await servicio.crearSesionPendiente(silla, 'ext-1');
    await jest.advanceTimersByTimeAsync(TIMEOUT_PAGO_MIN * 60_000);

    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sesion-nueva', estado: 'PENDIENTE' } }),
    );
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
  });
});

describe('SesionesService.activarSesion — casos adicionales', () => {
  it('lanza NotFoundException si la sesión no existe', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(null);

    await expect(servicio.activarSesion('sesion-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('es idempotente: si ya está ACTIVA, la devuelve tal cual sin tocar el relé', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(filaBase);

    const resultado = await servicio.activarSesion('sesion-1');

    expect(resultado).toBe(filaBase);
    expect(shelly.setRele).not.toHaveBeenCalled();
    expect(prisma.sesion.update).not.toHaveBeenCalled();
  });

  it('lanza ConflictException si la sesión está en un estado no activable (ej. COMPLETADA)', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, estado: 'COMPLETADA' });

    await expect(servicio.activarSesion('sesion-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('para una sesión ya pagada, conserva el pagadaEn original en vez de pisarlo', async () => {
    const { servicio, prisma } = crearServicio();
    const pagadaOriginal = new Date('2026-01-01T00:00:00.000Z');
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'PENDIENTE',
      finProgramado: null,
      pagadaEn: pagadaOriginal,
    });

    await servicio.activarSesion('sesion-1');

    const args = prisma.sesion.update.mock.calls[0][0];
    expect(args.data.pagadaEn).toEqual(pagadaOriginal);
  });

  it('si nunca se registró el pago, usa el momento del primer intento de activación', async () => {
    const { servicio, prisma } = crearServicio();
    jest.setSystemTime(new Date('2026-02-01T12:00:00.000Z'));
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'PENDIENTE',
      finProgramado: null,
      pagadaEn: null,
    });

    await servicio.activarSesion('sesion-1');

    const args = prisma.sesion.update.mock.calls[0][0];
    expect(args.data.pagadaEn).toEqual(new Date('2026-02-01T12:00:00.000Z'));
  });

  it('para una activación manual, nunca setea pagadaEn: no hay plata de cliente atrás', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'PENDIENTE',
      finProgramado: null,
      esManual: true,
      pagadaEn: new Date(),
    });

    await servicio.activarSesion('sesion-1');

    const args = prisma.sesion.update.mock.calls[0][0];
    expect(args.data.pagadaEn).toBeUndefined();
  });

  it('enciende el relé pidiendo a Shelly el auto-off por duración + margen', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'PENDIENTE',
      finProgramado: null,
      duracionMin: 10,
    });

    await servicio.activarSesion('sesion-1');

    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', true, 10 * 60 + MARGEN_AUTO_OFF_SEG);
  });

  it('calcula finProgramado desde el momento en que el relé confirmó, no desde el pedido', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    jest.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'PENDIENTE',
      finProgramado: null,
      duracionMin: 10,
    });

    await servicio.activarSesion('sesion-1');

    const args = prisma.sesion.update.mock.calls[0][0];
    const finEsperado = new Date('2026-03-01T10:10:00.000Z');
    expect(args.data.finProgramado).toEqual(finEsperado);
    expect(prisma.silla.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estado: 'EN_USO', finSesionActual: finEsperado }),
      }),
    );

    // El timer que programó activarSesion para el fin de la sesión también
    // tiene que disparar el apagado cuando llega la hora.
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'ACTIVA',
      interrumpidaEn: null,
      finProgramado: finEsperado,
    });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(shelly.setRele).toHaveBeenLastCalledWith('dev-1', false);
  });

  it('si el relé no responde, no pierde el pago: pasa a ESPERANDO_ENERGIA en vez de fallar', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    shelly.setRele.mockRejectedValueOnce(new Error('timeout Shelly Cloud'));
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'PENDIENTE',
      finProgramado: null,
      pagadaEn: null,
    });

    const resultado = await servicio.activarSesion('sesion-1');

    expect(resultado).toEqual(expect.objectContaining({ estado: 'ESPERANDO_ENERGIA' }));
    expect(prisma.sesion.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'ESPERANDO_ENERGIA' }) }),
    );
  });

  it('si el relé sigue sin responder tras MAX_ESPERA_ENERGIA_SEG, el pago se convierte en crédito', async () => {
    const { servicio, prisma, shelly, creditos } = crearServicio();
    shelly.setRele.mockRejectedValue(new Error('timeout'));
    jest.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const pendiente = { ...filaBase, estado: 'PENDIENTE', finProgramado: null, pagadaEn: null };
    prisma.sesion.findUnique.mockResolvedValue(pendiente);

    await servicio.activarSesion('sesion-1');
    // A partir de acá, cualquier relectura ve la sesión ya en ESPERANDO_ENERGIA.
    prisma.sesion.findUnique.mockResolvedValue({
      ...pendiente,
      estado: 'ESPERANDO_ENERGIA',
      pagadaEn: new Date(),
    });

    await jest.advanceTimersByTimeAsync(MAX_ESPERA_ENERGIA_SEG * 1000);

    expect(creditos.emitir).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: 'sin_energia_al_pagar', sesionOrigenId: 'sesion-1' }),
    );
  });

  it('en una activación manual, si el relé no responde, pasa a ESPERANDO_ENERGIA sin pagadaEn', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    shelly.setRele.mockRejectedValueOnce(new Error('sigue sin luz'));
    const creadaEn = new Date('2026-01-01T00:00:00.000Z');
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'PENDIENTE',
      finProgramado: null,
      esManual: true,
      pagadaEn: null,
      creadaEn,
    });
    // El mock por defecto de `update` solo devuelve los campos que se
    // patchean; acá necesitamos que la fila "actualizada" tenga creadaEn
    // real, porque sin pagadaEn el propio servicio cae a ese campo.
    prisma.sesion.update.mockImplementationOnce((args: any) =>
      Promise.resolve({ id: args.where.id, creadaEn, ...args.data }),
    );

    await servicio.activarSesion('sesion-1');

    const args = prisma.sesion.update.mock.calls[0][0];
    // esManual: no hay plata de cliente atrás, nunca se setea pagadaEn ni
    // siquiera en la rama de espera de energía.
    expect(args.data.pagadaEn).toBeUndefined();
  });

  it('si ya estaba ESPERANDO_ENERGIA con pagadaEn seteado, un reintento fallido conserva ese pagadaEn', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    const pagadaEn = new Date('2026-01-01T00:00:00.000Z');
    shelly.setRele.mockRejectedValueOnce(new Error('sigue sin luz'));
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'ESPERANDO_ENERGIA',
      finProgramado: null,
      pagadaEn,
    });

    await servicio.activarSesion('sesion-1');

    const args = prisma.sesion.update.mock.calls[0][0];
    expect(args.data.pagadaEn).toEqual(pagadaEn);
  });
});

describe('SesionesService.vencerEsperaEnergia — se acaba la paciencia, se emite el vale', () => {
  const base = { ...filaBase, estado: 'ESPERANDO_ENERGIA', finProgramado: null };

  it('si la sesión no existe, no hace nada', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(null);

    const resultado = await servicio.vencerEsperaEnergia('sesion-1');

    expect(resultado).toBeNull();
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('si ya no está ESPERANDO_ENERGIA (otra pasada la resolvió), no hace nada', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...base, estado: 'ACTIVA' });

    const resultado = await servicio.vencerEsperaEnergia('sesion-1');

    expect(resultado).toBeNull();
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('si otra pasada ya cerró la sesión (pierde la carrera), no emite un segundo vale', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(base);
    prisma.sesion.updateMany.mockResolvedValueOnce({ count: 0 });

    const resultado = await servicio.vencerEsperaEnergia('sesion-1');

    expect(resultado).toBeNull();
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('cierra la sesión como CANCELADA y emite el vale con la duración completa', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const pagadaEn = new Date('2026-01-01T00:00:00.000Z');
    prisma.sesion.findUnique.mockResolvedValue({ ...base, pagadaEn, duracionMin: 10 });
    creditos.emitir.mockResolvedValue({ codigo: 'LUZ-0001', duracionMin: 10 });

    await servicio.vencerEsperaEnergia('sesion-1');

    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'sesion-1', estado: { in: ['ESPERANDO_ENERGIA'] } }),
        data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'sin_energia_al_pagar' }),
      }),
    );
    expect(creditos.emitir).toHaveBeenCalledWith({
      duracionMin: 10,
      motivo: 'sin_energia_al_pagar',
      sesionOrigenId: 'sesion-1',
      prioridadDesde: pagadaEn,
    });
  });

  it('si pagadaEn nunca se seteó, usa creadaEn como antigüedad para la prioridad del vale', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const creadaEn = new Date('2026-01-01T00:00:00.000Z');
    prisma.sesion.findUnique.mockResolvedValue({ ...base, pagadaEn: null, creadaEn });

    await servicio.vencerEsperaEnergia('sesion-1');

    expect(creditos.emitir).toHaveBeenCalledWith(expect.objectContaining({ prioridadDesde: creadaEn }));
  });

  it('las activaciones manuales no generan vale: no hay plata de cliente que devolver', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...base, esManual: true });

    const resultado = await servicio.vencerEsperaEnergia('sesion-1');

    expect(resultado).toBeNull();
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('si emitir el vale falla, no rompe el cierre: la sesión ya quedó cerrada igual', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(base);
    creditos.emitir.mockRejectedValueOnce(new Error('DB caída'));

    const resultado = await servicio.vencerEsperaEnergia('sesion-1');

    expect(resultado).toBeNull();
  });
});

describe('SesionesService.registrarCorte', () => {
  it('si ya había un corte en curso (o la sesión no está ACTIVA), no lo cuenta de nuevo', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.updateMany.mockResolvedValueOnce({ count: 0 });

    const resultado = await servicio.registrarCorte('sesion-1', new Date());

    expect(resultado).toBe(false);
    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sesion-1', estado: 'ACTIVA', interrumpidaEn: null } }),
    );
  });

  it('marca el corte, incrementa el contador y guarda cuándo se detectó', async () => {
    const { servicio, prisma } = crearServicio();
    const detectadoEn = new Date('2026-01-01T00:00:00.000Z');

    const resultado = await servicio.registrarCorte('sesion-1', detectadoEn);

    expect(resultado).toBe(true);
    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { interrumpidaEn: detectadoEn, cortes: { increment: 1 } } }),
    );
  });
});

describe('SesionesService.reanudarTrasCorte — vuelve la luz dentro del umbral', () => {
  it.each([
    ['la sesión no existe', null],
    ['la sesión no está ACTIVA', { ...filaBase, estado: 'PENDIENTE' }],
    ['no hay corte en curso', { ...filaBase, interrumpidaEn: null }],
    [
      'no hay finProgramado',
      { ...filaBase, interrumpidaEn: new Date('2026-01-01T00:00:00.000Z'), finProgramado: null },
    ],
  ])('devuelve false si %s', async (_desc, fila) => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(fila);

    const resultado = await servicio.reanudarTrasCorte('sesion-1');

    expect(resultado).toBe(false);
    expect(shelly.setRele).not.toHaveBeenCalled();
  });

  it('devuelve el tiempo caído más la gracia de reinicio, y vuelve a prender el relé', async () => {
    const { servicio, prisma, shelly, sillas } = crearServicio();
    const ahora = new Date('2026-05-01T12:00:00.000Z').getTime();
    jest.setSystemTime(ahora);
    const interrumpidaEn = new Date(ahora - 90_000); // corte hace 90s
    const finProgramado = new Date(ahora + 120_000); // faltaban 2 min cuando cortó

    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, interrumpidaEn, finProgramado });

    const resultado = await servicio.reanudarTrasCorte('sesion-1');

    const devolver = 90 + GRACIA_REINICIO_SEG;
    const nuevoFin = new Date(finProgramado.getTime() + devolver * 1000);
    const restanteSeg = Math.round((nuevoFin.getTime() - ahora) / 1000);

    expect(resultado).toBe(true);
    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', true, restanteSeg + MARGEN_AUTO_OFF_SEG);
    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          interrumpidaEn: null,
          finProgramado: nuevoFin,
          segundosCompensados: { increment: devolver },
        }),
      }),
    );
    expect(prisma.silla.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { finSesionActual: nuevoFin } }),
    );
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');

    // El timer reprogramado para el nuevo fin también apaga el relé al vencer.
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      estado: 'ACTIVA',
      interrumpidaEn: null,
      finProgramado: nuevoFin,
    });
    await jest.advanceTimersByTimeAsync(restanteSeg * 1000);
    expect(shelly.setRele).toHaveBeenLastCalledWith('dev-1', false);
  });

  it('si otra pasada ya reanudó la sesión, no vuelve a devolver el tiempo (el ON ya salió, inofensivo)', async () => {
    const { servicio, prisma, shelly, sillas } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn: new Date('2026-01-01T00:00:00.000Z'),
      finProgramado: new Date('2026-01-01T00:05:00.000Z'),
    });
    prisma.sesion.updateMany.mockResolvedValueOnce({ count: 0 });

    const resultado = await servicio.reanudarTrasCorte('sesion-1');

    expect(resultado).toBe(false);
    expect(shelly.setRele).toHaveBeenCalled();
    expect(prisma.silla.update).not.toHaveBeenCalled();
    expect(sillas.invalidarCache).not.toHaveBeenCalled();
  });

  it('si el relé no responde al reencender, la excepción se propaga y no se toca interrumpidaEn', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn: new Date('2026-01-01T00:00:00.000Z'),
      finProgramado: new Date('2026-01-01T00:05:00.000Z'),
    });
    shelly.setRele.mockRejectedValueOnce(new Error('Shelly Cloud caída'));

    await expect(servicio.reanudarTrasCorte('sesion-1')).rejects.toThrow('Shelly Cloud caída');
    expect(prisma.sesion.updateMany).not.toHaveBeenCalled();
  });
});

describe('SesionesService.cerrarPorCorte — el corte pasó el umbral', () => {
  it.each([
    ['la sesión no existe', null],
    [
      'la sesión no está ACTIVA',
      {
        ...filaBase,
        estado: 'PENDIENTE',
        interrumpidaEn: new Date('2026-01-01T00:00:00.000Z'),
        finProgramado: new Date('2026-01-01T00:05:00.000Z'),
      },
    ],
    [
      'no hay corte en curso',
      {
        ...filaBase,
        interrumpidaEn: null,
        finProgramado: new Date('2026-01-01T00:05:00.000Z'),
      },
    ],
  ])('devuelve null si %s', async (_desc, fila) => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(fila);

    const resultado = await servicio.cerrarPorCorte('sesion-1');

    expect(resultado).toBeNull();
  });

  it('si no logra apagar el relé, no importa: igual cierra la sesión (al volver arranca abierto)', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    shelly.setRele.mockRejectedValueOnce(new Error('sigue sin luz'));
    const interrumpidaEn = new Date('2026-01-01T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + 400_000);
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, interrumpidaEn, finProgramado });

    await servicio.cerrarPorCorte('sesion-1');

    expect(prisma.sesion.updateMany).toHaveBeenCalled();
  });

  it('un corte sobre el final (≤ RESTO_DESPRECIABLE_SEG por delante) se da por cumplido, sin vale', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const interrumpidaEn = new Date('2026-01-01T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + (RESTO_DESPRECIABLE_SEG - 15) * 1000);
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, interrumpidaEn, finProgramado });

    const resultado = await servicio.cerrarPorCorte('sesion-1');

    expect(resultado).toBeNull();
    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estado: 'COMPLETADA', motivoCierre: 'corte_sobre_el_final' }),
      }),
    );
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('un corte largo cierra CANCELADA y emite un vale redondeando hacia arriba (125s -> 3 min)', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const interrumpidaEn = new Date('2026-01-01T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + 125_000);
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn,
      finProgramado,
      duracionMin: 10,
      pagadaEn: null,
      inicio: null,
      creadaEn: new Date('2025-12-31T00:00:00.000Z'),
    });
    creditos.emitir.mockResolvedValue({ codigo: 'LUZ-0002', duracionMin: 3 });

    await servicio.cerrarPorCorte('sesion-1');

    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'corte_de_energia' }),
      }),
    );
    expect(creditos.emitir).toHaveBeenCalledWith(
      expect.objectContaining({
        duracionMin: 3,
        motivo: 'corte_de_energia',
        prioridadDesde: new Date('2025-12-31T00:00:00.000Z'),
      }),
    );
  });

  it('si finProgramado es null (inconsistencia defensiva), da el resto por despreciable y no rompe', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const interrumpidaEn = new Date('2026-01-01T00:00:00.000Z');
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn,
      finProgramado: null,
    });

    const resultado = await servicio.cerrarPorCorte('sesion-1');

    expect(resultado).toBeNull();
    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estado: 'COMPLETADA', motivoCierre: 'corte_sobre_el_final' }),
      }),
    );
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('el vale nunca supera la duración original de la sesión (700s de corte, tope 10 min)', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const interrumpidaEn = new Date('2026-01-01T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + 700_000);
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn,
      finProgramado,
      duracionMin: 10,
    });

    await servicio.cerrarPorCorte('sesion-1');

    expect(creditos.emitir).toHaveBeenCalledWith(expect.objectContaining({ duracionMin: 10 }));
  });

  it('la prioridad del vale usa pagadaEn si existe, sin importar inicio ni creadaEn', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const pagadaEn = new Date('2026-01-01T00:00:00.000Z');
    const interrumpidaEn = new Date('2026-01-02T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + 200_000);
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn,
      finProgramado,
      pagadaEn,
      inicio: new Date('2026-01-01T12:00:00.000Z'),
    });

    await servicio.cerrarPorCorte('sesion-1');

    expect(creditos.emitir).toHaveBeenCalledWith(expect.objectContaining({ prioridadDesde: pagadaEn }));
  });

  it('sin pagadaEn, usa inicio como prioridad del vale', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const inicio = new Date('2026-01-01T12:00:00.000Z');
    const interrumpidaEn = new Date('2026-01-02T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + 200_000);
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn,
      finProgramado,
      pagadaEn: null,
      inicio,
    });

    await servicio.cerrarPorCorte('sesion-1');

    expect(creditos.emitir).toHaveBeenCalledWith(expect.objectContaining({ prioridadDesde: inicio }));
  });

  it('si otra pasada ya cerró la sesión, no emite un segundo vale', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const interrumpidaEn = new Date('2026-01-01T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + 200_000);
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, interrumpidaEn, finProgramado });
    prisma.sesion.updateMany.mockResolvedValueOnce({ count: 0 });

    const resultado = await servicio.cerrarPorCorte('sesion-1');

    expect(resultado).toBeNull();
    expect(creditos.emitir).not.toHaveBeenCalled();
  });

  it('las activaciones manuales no generan vale aunque el corte sea largo', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const interrumpidaEn = new Date('2026-01-01T00:00:00.000Z');
    const finProgramado = new Date(interrumpidaEn.getTime() + 200_000);
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      interrumpidaEn,
      finProgramado,
      esManual: true,
    });

    const resultado = await servicio.cerrarPorCorte('sesion-1');

    expect(resultado).toBeNull();
    expect(creditos.emitir).not.toHaveBeenCalled();
  });
});

describe('SesionesService.finalizarSesion — corta la corriente y libera', () => {
  it('si la sesión no existe, no hace nada', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(null);

    await servicio.finalizarSesion('sesion-1', 'tiempo_cumplido');

    expect(shelly.setRele).not.toHaveBeenCalled();
  });

  it('si la sesión ya no está ACTIVA, no hace nada (ya la cerró otra cosa)', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, estado: 'COMPLETADA' });

    await servicio.finalizarSesion('sesion-1', 'tiempo_cumplido');

    expect(shelly.setRele).not.toHaveBeenCalled();
  });

  it('si hay un corte en curso, posterga el cierre: no apaga ni libera', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue({ ...filaBase, interrumpidaEn: new Date() });

    await servicio.finalizarSesion('sesion-1', 'tiempo_cumplido');

    expect(shelly.setRele).not.toHaveBeenCalled();
    expect(prisma.sesion.updateMany).not.toHaveBeenCalled();
  });

  it('apaga el relé y cierra la sesión como COMPLETADA con el motivo recibido', async () => {
    const { servicio, prisma, shelly, sillas } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(filaBase);

    await servicio.finalizarSesion('sesion-1', 'tiempo_cumplido');

    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', false);
    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ estado: 'COMPLETADA', motivoCierre: 'tiempo_cumplido' }),
      }),
    );
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
  });

  it('si el relé no responde al apagar, igual cierra la sesión (el auto-off de Shelly es el fallback)', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    shelly.setRele.mockRejectedValueOnce(new Error('Shelly Cloud caída'));
    prisma.sesion.findUnique.mockResolvedValue(filaBase);

    await servicio.finalizarSesion('sesion-1', 'tiempo_cumplido');

    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'COMPLETADA' }) }),
    );
  });
});

describe('SesionesService.detenerEmergencia — parada de emergencia', () => {
  it('lanza NotFoundException si la silla no existe', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.silla.findUnique.mockResolvedValue(null);

    await expect(servicio.detenerEmergencia('silla-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(shelly.setRele).not.toHaveBeenCalled();
  });

  it('sin sesión activa: apaga el relé y libera la silla', async () => {
    const { servicio, prisma, shelly, sillas } = crearServicio();
    prisma.silla.findUnique.mockResolvedValue({ id: 'silla-1', nombre: 'Silla 1', deviceIdShelly: 'dev-1' });
    prisma.sesion.findFirst.mockResolvedValue(null);

    const resultado = await servicio.detenerEmergencia('silla-1');

    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', false);
    expect(prisma.silla.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { estado: 'LIBRE', finSesionActual: null } }),
    );
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
    expect(prisma.turno.updateMany).not.toHaveBeenCalled();
    expect(resultado).toEqual({ ok: true, sillaId: 'silla-1', sesionCancelada: null });
  });

  it('con una sesión activa: la cancela, cierra el turno enlazado y libera la silla', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.silla.findUnique.mockResolvedValue({ id: 'silla-1', nombre: 'Silla 1', deviceIdShelly: 'dev-1' });
    prisma.sesion.findFirst.mockResolvedValue({ id: 'sesion-1', sillaId: 'silla-1' });

    const resultado = await servicio.detenerEmergencia('silla-1');

    expect(prisma.sesion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sesion-1' },
        data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'parada_de_emergencia' }),
      }),
    );
    expect(prisma.turno.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sesionId: 'sesion-1', estado: 'EN_USO' },
        data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'parada_de_emergencia' }),
      }),
    );
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
    expect(resultado).toEqual({ ok: true, sillaId: 'silla-1', sesionCancelada: 'sesion-1' });
  });
});

describe('SesionesService.activarManual — activación desde el panel, sin pago', () => {
  it('lanza NotFoundException si la silla no existe', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.silla.findUnique.mockResolvedValue(null);

    await expect(servicio.activarManual('silla-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lanza ConflictException si la silla ya está en uso', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.silla.findUnique.mockResolvedValue({ id: 'silla-1', estado: 'EN_USO', duracionMin: 10 });

    await expect(servicio.activarManual('silla-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea una sesión manual (monto 0) con la duración de la silla y la activa', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.silla.findUnique.mockResolvedValue({
      id: 'silla-1',
      nombre: 'Silla 1',
      estado: 'LIBRE',
      duracionMin: 10,
      deviceIdShelly: 'dev-1',
    });
    prisma.sesion.create.mockResolvedValue({ id: 'sesion-manual' });
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      id: 'sesion-manual',
      estado: 'PENDIENTE',
      esManual: true,
      duracionMin: 10,
      finProgramado: null,
    });

    await servicio.activarManual('silla-1');

    expect(prisma.sesion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sillaId: 'silla-1',
          monto: 0,
          duracionMin: 10,
          esManual: true,
        }),
      }),
    );
    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', true, 10 * 60 + MARGEN_AUTO_OFF_SEG);
  });

  it('si se pide una duración distinta a la de la silla, usa esa en vez de la default', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.silla.findUnique.mockResolvedValue({
      id: 'silla-1',
      nombre: 'Silla 1',
      estado: 'LIBRE',
      duracionMin: 10,
      deviceIdShelly: 'dev-1',
    });
    prisma.sesion.create.mockResolvedValue({ id: 'sesion-manual' });
    prisma.sesion.findUnique.mockResolvedValue({
      ...filaBase,
      id: 'sesion-manual',
      estado: 'PENDIENTE',
      esManual: true,
      duracionMin: 5,
      finProgramado: null,
    });

    await servicio.activarManual('silla-1', 5);

    expect(prisma.sesion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ duracionMin: 5 }) }),
    );
  });
});

describe('SesionesService.expirarPagoPendiente — casos adicionales', () => {
  it('si ya no está PENDIENTE (perdió la carrera), no toca nada más', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.sesion.updateMany.mockResolvedValueOnce({ count: 0 });

    await servicio.expirarPagoPendiente('sesion-1');

    expect(prisma.silla.updateMany).not.toHaveBeenCalled();
    expect(sillas.invalidarCache).not.toHaveBeenCalled();
  });

  it('si la sesión desapareció justo después de expirar, no intenta liberar una silla inexistente', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.sesion.findUnique.mockResolvedValue(null);

    await servicio.expirarPagoPendiente('sesion-1');

    expect(prisma.silla.updateMany).not.toHaveBeenCalled();
    expect(sillas.invalidarCache).not.toHaveBeenCalled();
  });
});

describe('SesionesService — cancelación de timers al cambiar de estado', () => {
  it('activar la sesión antes de que venza el pago cancela el timer de expiración de pago', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.create.mockResolvedValue({ id: 'sesion-1' });
    const pendiente = { ...filaBase, id: 'sesion-1', estado: 'PENDIENTE', finProgramado: null };
    prisma.sesion.findUnique.mockResolvedValue(pendiente);

    await servicio.crearSesionPendiente(
      { id: 'silla-1', nombre: 'Silla 1', precio: 1000, duracionMin: 10 } as any,
      'ext-ref',
    );
    prisma.sesion.updateMany.mockClear();

    await servicio.activarSesion('sesion-1');
    await jest.advanceTimersByTimeAsync(TIMEOUT_PAGO_MIN * 60_000);

    // El timer de "expirar por falta de pago" fue cancelado por activarSesion:
    // no debería quedar ningún updateMany con estado PENDIENTE.
    const llamadasExpiracion = prisma.sesion.updateMany.mock.calls.filter(
      ([args]: any) => args.where?.estado === 'PENDIENTE',
    );
    expect(llamadasExpiracion).toHaveLength(0);
  });
});

describe('SesionesService — ventana de confirmación tras el pago directo', () => {
  const sesionPendiente = {
    id: 'sesion-1',
    sillaId: 'silla-1',
    estado: 'PENDIENTE',
    duracionMin: 10,
    silla: { id: 'silla-1', nombre: 'Silla 1', deviceIdShelly: 'dev-1' },
  };

  it('esperarConfirmacion: reserva la silla y NO enciende el relé', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique = jest.fn().mockResolvedValue(sesionPendiente);

    await servicio.esperarConfirmacion('sesion-1');

    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sesion-1', estado: 'PENDIENTE' },
        data: expect.objectContaining({ estado: 'ESPERANDO_CONFIRMACION' }),
      }),
    );
    expect(prisma.silla.updateMany).toHaveBeenCalledWith({
      where: { id: 'silla-1', estado: 'PAGO_PENDIENTE' },
      data: { estado: 'RESERVADA' },
    });
    expect(shelly.setRele).not.toHaveBeenCalled();
  });

  it('esperarConfirmacion: si la sesión ya no estaba PENDIENTE tira ConflictException', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique = jest
      .fn()
      .mockResolvedValue({ ...sesionPendiente, estado: 'CANCELADA' });

    await expect(servicio.esperarConfirmacion('sesion-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('esperarConfirmacion: es idempotente si ya estaba esperando confirmación', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique = jest
      .fn()
      .mockResolvedValue({ ...sesionPendiente, estado: 'ESPERANDO_CONFIRMACION' });

    await servicio.esperarConfirmacion('sesion-1');

    expect(prisma.sesion.updateMany).not.toHaveBeenCalled();
  });

  it('confirmarSesion: desde ESPERANDO_CONFIRMACION enciende la silla', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique = jest
      .fn()
      .mockResolvedValue({ ...sesionPendiente, estado: 'ESPERANDO_CONFIRMACION' });

    const res = await servicio.confirmarSesion('sesion-1');

    expect(shelly.setRele).toHaveBeenCalledWith('dev-1', true, expect.any(Number));
    expect(res).toEqual({ ok: true, sillaId: 'silla-1' });
  });

  it('confirmarSesion: si ya venció (CANCELADA) tira ConflictException y no enciende', async () => {
    const { servicio, prisma, shelly } = crearServicio();
    prisma.sesion.findUnique = jest
      .fn()
      .mockResolvedValue({ ...sesionPendiente, estado: 'CANCELADA' });

    await expect(servicio.confirmarSesion('sesion-1')).rejects.toBeInstanceOf(ConflictException);
    expect(shelly.setRele).not.toHaveBeenCalled();
  });

  it('expirarConfirmacion: cancela la sesión y libera la silla reservada', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.sesion.findUnique = jest.fn().mockResolvedValue(sesionPendiente);

    await servicio.expirarConfirmacion('sesion-1');

    expect(prisma.sesion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sesion-1', estado: 'ESPERANDO_CONFIRMACION' },
        data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'no_confirmo_a_tiempo' }),
      }),
    );
    expect(prisma.silla.updateMany).toHaveBeenCalledWith({
      where: { id: 'silla-1', estado: 'RESERVADA' },
      data: { estado: 'LIBRE' },
    });
  });
});
