import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ColaService, TIMEOUT_PAGO_TURNO_MIN } from './cola.service';

function crearServicio(
  opciones: {
    turnstileOk?: boolean;
    pendientesPorHash?: Record<string, number>;
    creditoTomar?: jest.Mock;
    heartbeatOffline?: (sillaId: string) => boolean;
    activarSesion?: jest.Mock;
  } = {},
) {
  const pendientesPorHash = opciones.pendientesPorHash ?? {};

  const prisma: any = {
    silla: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'silla-1', precio: 1000, duracionMin: 10 },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'silla-1',
        graciaInicioSeg: 30,
        pausaRetornoSeg: 10,
        retornoSeg: 40,
      }),
    },
    turno: {
      create: jest.fn((args) => Promise.resolve({ id: 'turno-1', ...args.data })),
      count: jest.fn((args) => Promise.resolve(pendientesPorHash[args.where.ipHash] ?? 0)),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
    sesion: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'sesion-1' }),
    },
    credito: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));
  prisma.$executeRaw = jest.fn().mockResolvedValue(0);
  const mp: any = {
    crearPreferencia: jest.fn().mockResolvedValue({ id: 'p1', initPoint: 'https://mp.test/turno' }),
  };
  const sesiones: any = {
    activarSesion: opciones.activarSesion ?? jest.fn().mockResolvedValue(undefined),
  };
  const heartbeat: any = { estaOffline: jest.fn(opciones.heartbeatOffline ?? (() => false)) };
  const creditos: any = {
    tomar:
      opciones.creditoTomar ??
      jest.fn().mockResolvedValue({ id: 'credito-1', codigo: 'LUZ-AAAA-BBBB', duracionMin: 10, prioridadDesde: new Date() }),
    vincularTurno: jest.fn().mockResolvedValue(undefined),
    porSesion: jest.fn().mockResolvedValue(null),
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
  const sillas: any = { invalidarCache: jest.fn() };
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
    sillas,
    config,
  );
  return { servicio, prisma, mp, turnstile, ipHash, creditos, fallosCanje, sillas, heartbeat, sesiones };
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

  it('sin sillas disponibles en el local (todas FUERA_DE_SERVICIO), tira NotFoundException y no cobra', async () => {
    const { servicio, prisma, mp } = crearServicio();
    prisma.silla.findMany = jest.fn().mockResolvedValue([]);

    await expect(
      servicio.unirse(undefined, 'token-ok', '1.2.3.4'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.turno.create).not.toHaveBeenCalled();
    expect(mp.crearPreferencia).not.toHaveBeenCalled();
  });

  it('con todas las sillas sin energía (heartbeat offline), tira ConflictException y no cobra', async () => {
    const { servicio, prisma, mp } = crearServicio({ heartbeatOffline: () => true });

    await expect(
      servicio.unirse(undefined, 'token-ok', '1.2.3.4'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.turno.create).not.toHaveBeenCalled();
    expect(mp.crearPreferencia).not.toHaveBeenCalled();
  });

  it('si falla la creación de la preferencia en Mercado Pago, cancela el turno recién creado y propaga el error', async () => {
    const { servicio, prisma, mp } = crearServicio();
    mp.crearPreferencia = jest.fn().mockRejectedValue(new Error('mp caída'));
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 1 });

    await expect(
      servicio.unirse(undefined, 'token-ok', '1.2.3.4'),
    ).rejects.toThrow('mp caída');

    // expirarEsperaPago del turno recién creado: no le cobramos algo que MP
    // nunca llegó a ofrecerle.
    expect(prisma.turno.updateMany).toHaveBeenCalledWith({
      where: { id: 'turno-1', estado: 'ESPERANDO_PAGO' },
      data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'pago_no_recibido' }),
    });
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

  it('si falla la creación del turno tras tomar el vale, lo revierte a DISPONIBLE y propaga el error', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    prisma.turno.create = jest.fn().mockRejectedValue(new Error('db caída'));

    await expect(
      servicio.canjearCredito('LUZ-AAAA-BBBB', '1.2.3.4'),
    ).rejects.toThrow('db caída');

    // No dejamos el vale "quemado" (CANJEADO) por un error nuestro: se
    // repone a DISPONIBLE para que el cliente lo pueda reintentar.
    expect(prisma.credito.updateMany).toHaveBeenCalledWith({
      where: { id: 'credito-1', estado: 'CANJEADO' },
      data: { estado: 'DISPONIBLE', canjeadoEn: null },
    });
    expect(creditos.vincularTurno).not.toHaveBeenCalled();
  });
});

describe('ColaService — cache TTL y invalidación de estado (Bloque C)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('estadoResumen: dos llamadas dentro del TTL solo pegan una vez a la base', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.silla.count = jest.fn().mockResolvedValue(3);
    prisma.turno.count = jest.fn().mockResolvedValue(2);

    const primero = await servicio.estadoResumen();
    const segundo = await servicio.estadoResumen();

    expect(primero).toEqual(segundo);
    expect(prisma.turno.count).toHaveBeenCalledTimes(1);
    // silla.count se llama dos veces POR carga (libres + total): una sola
    // carga entre las dos llamadas de arriba.
    expect(prisma.silla.count).toHaveBeenCalledTimes(2);
  });

  it('invalidarCacheResumen() fuerza que estadoResumen() vuelva a pegarle a la base', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.silla.count = jest.fn().mockResolvedValue(1);
    prisma.turno.count = jest.fn().mockResolvedValue(1);

    await servicio.estadoResumen();
    servicio.invalidarCacheResumen();
    await servicio.estadoResumen();

    expect(prisma.turno.count).toHaveBeenCalledTimes(2);
  });

  it('estadoTurno: dos llamadas dentro del TTL solo pegan una vez a la base por el turno', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1',
      codigo: 'ABC-1234',
      estado: 'EN_COLA',
      pagadoEn: null,
      asignadoEn: null,
      duracionMin: 10,
      motivoCierre: null,
      sesionId: null,
      silla: null,
      sesion: null,
    });

    await servicio.estadoTurno('turno-1');
    await servicio.estadoTurno('turno-1');

    expect(prisma.turno.findUnique).toHaveBeenCalledTimes(1);
  });

  it('estadoTurno recalcula segundosVentana en vivo aunque el turno venga de la cache', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1',
      codigo: 'ABC-1234',
      estado: 'ASIGNADO',
      pagadoEn: new Date(),
      asignadoEn: new Date(),
      duracionMin: 10,
      motivoCierre: null,
      sesionId: null,
      silla: null,
      sesion: null,
    });

    const primero = await servicio.estadoTurno('turno-1');
    const ahoraReal = Date.now;
    jest.spyOn(Date, 'now').mockReturnValue(ahoraReal() + 10_000);
    try {
      const segundo = await servicio.estadoTurno('turno-1');
      expect(segundo.segundosVentana).toBeLessThan(primero.segundosVentana!);
    } finally {
      jest.spyOn(Date, 'now').mockRestore();
    }
  });

  it('procesarPagoAprobado invalida la cache del turno y la del resumen (enCola cambió)', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const spyTurno = jest.spyOn(servicio, 'invalidarCacheTurno');
    const spyResumen = jest.spyOn(servicio, 'invalidarCacheResumen');

    await servicio.procesarPagoAprobado('turno-1');

    expect(spyTurno).toHaveBeenCalledWith('turno-1');
    expect(spyResumen).toHaveBeenCalled();
  });

  it('canjearCredito invalida la cache del resumen: el turno nace directo en EN_COLA', async () => {
    const { servicio, prisma } = crearServicio();
    const spyResumen = jest.spyOn(servicio, 'invalidarCacheResumen');

    await servicio.canjearCredito('LUZ-AAAA-BBBB', '1.2.3.4');

    expect(spyResumen).toHaveBeenCalled();
    expect(prisma.turno.create).toHaveBeenCalled();
  });

  it('intentarAsignar invalida la cache de SillasService y el resumen al reservar una silla', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.turno.findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'turno-1', codigo: 'ABC-1234', pagadoEn: new Date() })
      .mockResolvedValue(null);
    prisma.silla.findMany = jest.fn().mockResolvedValue([{ id: 'silla-1', nombre: 'Silla 1' }]);
    prisma.silla.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const spyResumen = jest.spyOn(servicio, 'invalidarCacheResumen');
    const spyTurno = jest.spyOn(servicio, 'invalidarCacheTurno');
    // No hace falta que la ventana de confirmación llegue a programarse de
    // verdad para esta aserción (solo importa la invalidación de caches):
    // se neutraliza para no dejar un timer (ni siquiera fake) pendiente.
    jest.spyOn(servicio as any, 'programar').mockImplementation(() => undefined);

    await servicio.intentarAsignar();

    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
    expect(spyTurno).toHaveBeenCalledWith('turno-1');
    expect(spyResumen).toHaveBeenCalled();
  });
});

describe('ColaService.onApplicationBootstrap — recuperación tras reinicio', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('expira turnos ESPERANDO_PAGO y ASIGNADO cuyo límite ya venció, programa timer para los vigentes, y siempre reintenta asignar', async () => {
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const ahora = Date.now();
    const { servicio, prisma } = crearServicio();

    const vencido = { id: 'turno-vencido', creadoEn: new Date(ahora - 10 * 60_000) };
    const vigente = { id: 'turno-vigente', creadoEn: new Date(ahora - 60_000) };
    const asigVencido = {
      id: 'turno-asig-vencido',
      asignadoEn: new Date(ahora - 5 * 60_000),
      creadoEn: new Date(ahora - 5 * 60_000),
    };
    const asigVigente = {
      id: 'turno-asig-vigente',
      asignadoEn: new Date(ahora - 30_000),
      creadoEn: new Date(ahora - 30_000),
    };
    prisma.turno.findMany = jest.fn((args: any) => {
      if (args.where.estado === 'ESPERANDO_PAGO') return Promise.resolve([vencido, vigente]);
      if (args.where.estado === 'ASIGNADO') return Promise.resolve([asigVencido, asigVigente]);
      return Promise.resolve([]);
    });

    const spyExpiraPago = jest.spyOn(servicio, 'expirarEsperaPago');
    const spyExpiraVentana = jest.spyOn(servicio as any, 'expirarVentanaConfirmacion');
    const spyAsignar = jest.spyOn(servicio, 'intentarAsignar');
    // Se neutraliza programar(): solo interesa CON QUÉ se lo llama, no que
    // deje un timer (ni siquiera fake) pendiente sin avanzar ni limpiar.
    const spyProgramar = jest.spyOn(servicio as any, 'programar').mockImplementation(() => undefined);

    await servicio.onApplicationBootstrap();

    expect(spyExpiraPago).toHaveBeenCalledWith('turno-vencido');
    expect(spyExpiraPago).not.toHaveBeenCalledWith('turno-vigente');
    expect(spyExpiraVentana).toHaveBeenCalledWith('turno-asig-vencido');
    expect(spyExpiraVentana).not.toHaveBeenCalledWith('turno-asig-vigente');
    expect(spyProgramar).toHaveBeenCalledWith('turno-vigente', expect.any(Date), expect.any(Function));
    expect(spyProgramar).toHaveBeenCalledWith(
      'turno-asig-vigente',
      expect.any(Date),
      expect.any(Function),
    );
    expect(spyAsignar).toHaveBeenCalled();
  });

  it('usa creadoEn como base de la ventana de confirmación cuando asignadoEn es null', async () => {
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const ahora = Date.now();
    const { servicio, prisma } = crearServicio();
    const asigSinAsignadoEn = {
      id: 'turno-asig-legacy',
      asignadoEn: null,
      creadoEn: new Date(ahora - 5 * 60_000), // > 2 min: ya venció
    };
    prisma.turno.findMany = jest.fn((args: any) => {
      if (args.where.estado === 'ASIGNADO') return Promise.resolve([asigSinAsignadoEn]);
      return Promise.resolve([]);
    });
    const spyExpiraVentana = jest.spyOn(servicio as any, 'expirarVentanaConfirmacion');

    await servicio.onApplicationBootstrap();

    expect(spyExpiraVentana).toHaveBeenCalledWith('turno-asig-legacy');
  });
});

describe('ColaService — tick periódico de reintento de asignación', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('llama a intentarAsignar en cada tick', async () => {
    const { servicio } = crearServicio();
    const spy = jest.spyOn(servicio, 'intentarAsignar').mockResolvedValue(undefined);

    await (servicio as any).tick();

    expect(spy).toHaveBeenCalled();
  });

  it('si intentarAsignar falla, el tick lo atrapa y lo loguea (no revienta el proceso)', async () => {
    const { servicio } = crearServicio();
    const err = new Error('db caída');
    jest.spyOn(servicio, 'intentarAsignar').mockRejectedValue(err);
    const errorSpy = jest
      .spyOn((servicio as any).logger, 'error')
      .mockImplementation(() => undefined);

    await (servicio as any).tick();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error en tick de asignación'));
  });
});

describe('ColaService.expirarEsperaPago — ESPERANDO_PAGO → CANCELADA', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('es idempotente: si el turno ya no está ESPERANDO_PAGO (ya se pagó o ya se canceló), no hace nada', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const spy = jest.spyOn(servicio, 'invalidarCacheTurno');

    await servicio.expirarEsperaPago('turno-1');

    expect(spy).not.toHaveBeenCalled();
  });

  it('cancela el timer pendiente del turno y lo marca CANCELADA cuando sigue ESPERANDO_PAGO', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    // unirse() programa un timer real de expiración para 'turno-1' (el id
    // que siempre devuelve el mock de turno.create).
    await servicio.unirse(undefined, 'token-ok', '1.2.3.4');
    prisma.turno.create.mockClear();

    await servicio.expirarEsperaPago('turno-1');

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(prisma.turno.updateMany).toHaveBeenCalledWith({
      where: { id: 'turno-1', estado: 'ESPERANDO_PAGO' },
      data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'pago_no_recibido' }),
    });
  });
});

describe('ColaService.procesarPagoAprobado — webhook tardío o duplicado', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('si el turno ya no estaba ESPERANDO_PAGO, tira ConflictException sin tocar la cola (para que PagosService marque el pago a revisión)', async () => {
    // Corregido en Bloque E: antes este caso solo logueaba y retornaba, lo
    // que dejaba a PagosService.procesarPagoDeTurno sin forma de detectar
    // un pago aprobado que llega tarde (turno ya vencido/cancelado) — el
    // `catch (e) { if (e instanceof ConflictException) ... }` de ese método
    // nunca se disparaba y el pago quedaba sin `requiereRevision=true`.
    // Ahora se comporta igual que SesionesService.activarSesion en el caso
    // análogo: tira ConflictException.
    const { servicio, prisma } = crearServicio();
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const spyResumen = jest.spyOn(servicio, 'invalidarCacheResumen');
    const spyTurno = jest.spyOn(servicio, 'invalidarCacheTurno');
    const spyAsignar = jest.spyOn(servicio, 'intentarAsignar');

    await expect(servicio.procesarPagoAprobado('turno-1')).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(spyResumen).not.toHaveBeenCalled();
    expect(spyTurno).not.toHaveBeenCalled();
    expect(spyAsignar).not.toHaveBeenCalled();
  });

  it('si no logra generar un código de turno único en 10 intentos, tira error y no actualiza el turno', async () => {
    const { servicio, prisma } = crearServicio();
    // Simula que cualquier código candidato ya existe en la base.
    prisma.turno.findUnique = jest.fn().mockResolvedValue({ id: 'otro-turno', codigo: 'ABC-1234' });

    await expect(servicio.procesarPagoAprobado('turno-1')).rejects.toThrow(
      'No se pudo generar un código de turno único',
    );

    expect(prisma.turno.findUnique).toHaveBeenCalledTimes(10);
    expect(prisma.turno.updateMany).not.toHaveBeenCalled();
  });
});

describe('ColaService.intentarAsignar — asignación de sillas libres a la cola', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('sin turnos EN_COLA, no toca sillas', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findFirst = jest.fn().mockResolvedValue(null);

    await servicio.intentarAsignar();

    expect(prisma.silla.findMany).not.toHaveBeenCalled();
    expect(prisma.silla.updateMany).not.toHaveBeenCalled();
  });

  it('con turno en cola pero sin sillas libres, deja el turno esperando', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'turno-1', codigo: 'ABC-1234', pagadoEn: new Date() });
    prisma.silla.findMany = jest.fn().mockResolvedValue([]);

    await servicio.intentarAsignar();

    expect(prisma.silla.updateMany).not.toHaveBeenCalled();
    expect(prisma.turno.updateMany).not.toHaveBeenCalled();
  });

  it('con la única silla libre sin energía (heartbeat offline), no la asigna', async () => {
    const { servicio, prisma } = crearServicio({ heartbeatOffline: () => true });
    prisma.turno.findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'turno-1', codigo: 'ABC-1234', pagadoEn: new Date() });
    prisma.silla.findMany = jest.fn().mockResolvedValue([{ id: 'silla-1', nombre: 'Silla 1' }]);

    await servicio.intentarAsignar();

    expect(prisma.silla.updateMany).not.toHaveBeenCalled();
  });

  it('CAS de la silla: si otra ejecución la reserva primero (count 0), no asigna ese turno', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'turno-1', codigo: 'ABC-1234', pagadoEn: new Date() })
      .mockResolvedValue(null);
    prisma.silla.findMany = jest.fn().mockResolvedValue([{ id: 'silla-1', nombre: 'Silla 1' }]);
    prisma.silla.updateMany = jest.fn().mockResolvedValue({ count: 0 }); // CAS perdido

    await servicio.intentarAsignar();

    expect(prisma.turno.updateMany).not.toHaveBeenCalled();
  });

  it('si el turno se cancela justo antes de asignarse (CAS del turno en count 0), libera la silla ya reservada', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.turno.findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'turno-1', codigo: 'ABC-1234', pagadoEn: new Date() })
      .mockResolvedValue(null);
    prisma.silla.findMany = jest.fn().mockResolvedValue([{ id: 'silla-1', nombre: 'Silla 1' }]);
    prisma.silla.updateMany = jest.fn().mockResolvedValue({ count: 1 }); // reserva y liberación, ambas ok
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 0 }); // el turno ya no está EN_COLA
    const spyResumen = jest.spyOn(servicio, 'invalidarCacheResumen');

    await servicio.intentarAsignar();

    expect(prisma.silla.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'silla-1', estado: 'LIBRE' },
      data: { estado: 'RESERVADA' },
    });
    expect(prisma.silla.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'silla-1', estado: 'RESERVADA' },
      data: { estado: 'LIBRE' },
    });
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
    // se invalida una vez al reservar (baja) y otra al liberar (sube).
    expect(spyResumen.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ColaService.confirmar — ASIGNADO → EN_USO', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('turno inexistente: tira NotFoundException', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest.fn().mockResolvedValue(null);

    await expect(servicio.confirmar('turno-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turno que no está ASIGNADO: tira ConflictException y no crea sesión', async () => {
    const { servicio, prisma, sesiones } = crearServicio();
    prisma.turno.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 'turno-1', estado: 'EN_COLA', sillaId: null });

    await expect(servicio.confirmar('turno-1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.sesion.create).not.toHaveBeenCalled();
    expect(sesiones.activarSesion).not.toHaveBeenCalled();
  });

  it('turno ASIGNADO pero sin sillaId (inconsistencia defensiva): tira ConflictException', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 'turno-1', estado: 'ASIGNADO', sillaId: null });

    await expect(servicio.confirmar('turno-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('turno ASIGNADO válido: crea la sesión, activa la silla y pasa el turno a EN_USO', async () => {
    const { servicio, prisma, sesiones } = crearServicio();
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1',
      estado: 'ASIGNADO',
      sillaId: 'silla-1',
      monto: 1000,
      duracionMin: 10,
    });
    const spyTurno = jest.spyOn(servicio, 'invalidarCacheTurno');

    const resultado = await servicio.confirmar('turno-1');

    expect(prisma.sesion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sillaId: 'silla-1',
        externalReference: 'turno-sesion:turno-1',
        monto: 1000,
        duracionMin: 10,
      }),
    });
    expect(sesiones.activarSesion).toHaveBeenCalledWith('sesion-1');
    expect(prisma.turno.update).toHaveBeenCalledWith({
      where: { id: 'turno-1' },
      data: { estado: 'EN_USO', sesionId: 'sesion-1' },
    });
    expect(spyTurno).toHaveBeenCalledWith('turno-1');
    expect(resultado).toEqual({ ok: true, sillaId: 'silla-1' });
  });

  it('propaga el error si sesiones.activarSesion falla (ej. Shelly no responde) sin marcar el turno EN_USO', async () => {
    const { servicio, prisma } = crearServicio({
      activarSesion: jest.fn().mockRejectedValue(new Error('Shelly no responde')),
    });
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1',
      estado: 'ASIGNADO',
      sillaId: 'silla-1',
      monto: 1000,
      duracionMin: 10,
    });

    await expect(servicio.confirmar('turno-1')).rejects.toThrow('Shelly no responde');

    expect(prisma.turno.update).not.toHaveBeenCalled();
  });
});

describe('ColaService.expirarVentanaConfirmacion — ASIGNADO → CANCELADA (no confirmó a tiempo)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('turno inexistente: no hace nada', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest.fn().mockResolvedValue(null);

    await (servicio as any).expirarVentanaConfirmacion('turno-x');

    expect(prisma.turno.update).not.toHaveBeenCalled();
  });

  it('turno que ya no está ASIGNADO (se confirmó o se canceló antes): no hace nada', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 'turno-1', estado: 'EN_USO', sillaId: 'silla-1' });

    await (servicio as any).expirarVentanaConfirmacion('turno-1');

    expect(prisma.turno.update).not.toHaveBeenCalled();
  });

  it('turno ASIGNADO vencido: lo cancela, libera la silla RESERVADA y reintenta asignar', async () => {
    const { servicio, prisma, sillas } = crearServicio();
    prisma.turno.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 'turno-1', estado: 'ASIGNADO', sillaId: 'silla-1' });
    const spyTurno = jest.spyOn(servicio, 'invalidarCacheTurno');
    const spyResumen = jest.spyOn(servicio, 'invalidarCacheResumen');
    const spyAsignar = jest.spyOn(servicio, 'intentarAsignar').mockResolvedValue(undefined);

    await (servicio as any).expirarVentanaConfirmacion('turno-1');

    expect(prisma.turno.update).toHaveBeenCalledWith({
      where: { id: 'turno-1' },
      data: expect.objectContaining({ estado: 'CANCELADA', motivoCierre: 'no_confirmo_a_tiempo' }),
    });
    expect(prisma.silla.updateMany).toHaveBeenCalledWith({
      where: { id: 'silla-1', estado: 'RESERVADA' },
      data: { estado: 'LIBRE' },
    });
    expect(sillas.invalidarCache).toHaveBeenCalledWith('silla-1');
    expect(spyTurno).toHaveBeenCalledWith('turno-1');
    expect(spyResumen).toHaveBeenCalled();
    expect(spyAsignar).toHaveBeenCalled();
  });

  it('turno ASIGNADO sin sillaId (caso defensivo): cancela el turno sin tocar sillas', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest
      .fn()
      .mockResolvedValue({ id: 'turno-1', estado: 'ASIGNADO', sillaId: null });
    const spyAsignar = jest.spyOn(servicio, 'intentarAsignar').mockResolvedValue(undefined);

    await (servicio as any).expirarVentanaConfirmacion('turno-1');

    expect(prisma.silla.updateMany).not.toHaveBeenCalled();
    expect(spyAsignar).toHaveBeenCalled();
  });
});

describe('ColaService.estadoTurno — cálculos en vivo según el estado', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('turno EN_COLA sin sillas libres: expone los segundos hasta que se libere la próxima silla', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1', codigo: 'ABC-1234', estado: 'EN_COLA', pagadoEn: new Date(),
      asignadoEn: null, duracionMin: 10, motivoCierre: null, sesionId: null, silla: null, sesion: null,
    });
    prisma.turno.count = jest.fn().mockResolvedValue(0);
    prisma.silla.count = jest.fn().mockResolvedValue(0);
    prisma.silla.findFirst = jest
      .fn()
      .mockResolvedValue({ finSesionActual: new Date(Date.now() + 90_000) });

    const estado = await servicio.estadoTurno('turno-1');

    expect(estado.segundosProximaSilla).toBeGreaterThan(80);
    expect(estado.segundosProximaSilla).toBeLessThanOrEqual(90);
  });

  it('turno EN_COLA con pagadoEn: calcula posición en la fila y sillas libres', async () => {
    const { servicio, prisma } = crearServicio();
    const pagadoEn = new Date();
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1',
      codigo: 'ABC-1234',
      estado: 'EN_COLA',
      pagadoEn,
      asignadoEn: null,
      duracionMin: 10,
      motivoCierre: null,
      sesionId: null,
      silla: null,
      sesion: null,
    });
    prisma.turno.count = jest.fn().mockResolvedValue(2);
    prisma.silla.count = jest.fn().mockResolvedValue(1);

    const estado = await servicio.estadoTurno('turno-1');

    expect(prisma.turno.count).toHaveBeenCalledWith({
      where: { estado: 'EN_COLA', pagadoEn: { lt: pagadoEn } },
    });
    expect(estado.posicion).toBe(2);
    expect(estado.sillasLibres).toBe(1);
  });

  it('turno EN_USO con silla.finSesionActual: calcula segundosRestantesSesion', async () => {
    const { servicio, prisma } = crearServicio();
    const finSesionActual = new Date(Date.now() + 120_000);
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1',
      codigo: 'ABC-1234',
      estado: 'EN_USO',
      pagadoEn: new Date(),
      asignadoEn: new Date(),
      duracionMin: 10,
      motivoCierre: null,
      sesionId: 'sesion-1',
      silla: { id: 'silla-1', nombre: 'Silla 1', finSesionActual },
      sesion: { id: 'sesion-1', estado: 'ACTIVA', interrumpidaEn: null },
    });

    const estado = await servicio.estadoTurno('turno-1');

    expect(estado.segundosRestantesSesion).toBeGreaterThan(0);
    expect(estado.segundosRestantesSesion).toBeLessThanOrEqual(120);
  });

  it('turno con sesión asociada: incluye el vale (crédito) emitido por esa sesión, si existe', async () => {
    const { servicio, prisma, creditos } = crearServicio();
    const venceEn = new Date(Date.now() + 3600_000);
    creditos.porSesion = jest
      .fn()
      .mockResolvedValue({ codigo: 'LUZ-XXXX-YYYY', duracionMin: 10, estado: 'DISPONIBLE', venceEn });
    prisma.turno.findUnique = jest.fn().mockResolvedValue({
      id: 'turno-1',
      codigo: 'ABC-1234',
      estado: 'CANCELADA',
      pagadoEn: null,
      asignadoEn: null,
      duracionMin: 10,
      motivoCierre: 'corte_de_energia',
      sesionId: 'sesion-1',
      silla: null,
      sesion: null,
    });

    const estado = await servicio.estadoTurno('turno-1');

    expect(creditos.porSesion).toHaveBeenCalledWith('sesion-1');
    expect(estado.credito).toEqual(
      expect.objectContaining({ codigo: 'LUZ-XXXX-YYYY', estado: 'DISPONIBLE' }),
    );
  });

  it('turno inexistente: tira NotFoundException', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findUnique = jest.fn().mockResolvedValue(null);

    await expect(servicio.estadoTurno('turno-x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ColaService — timers programados: éxito y manejo de errores', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('si la función agendada por un timer falla, el error se atrapa y se loguea (no revienta el proceso)', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.updateMany = jest.fn().mockRejectedValue(new Error('db caída'));
    const errorSpy = jest
      .spyOn((servicio as any).logger, 'error')
      .mockImplementation(() => undefined);

    // Programa expirarEsperaPago para dentro de TIMEOUT_PAGO_TURNO_MIN.
    await servicio.unirse(undefined, 'token-ok', '1.2.3.4');

    await jest.advanceTimersByTimeAsync(TIMEOUT_PAGO_TURNO_MIN * 60_000 + 1_000);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error en timer de turno'));
  });

  it('intentarAsignar programa la ventana de confirmación (VENTANA_CONFIRMACION_MIN) tras asignar la silla', async () => {
    const { servicio, prisma } = crearServicio();
    prisma.turno.findFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'turno-1', codigo: 'ABC-1234', pagadoEn: new Date() })
      .mockResolvedValue(null);
    prisma.silla.findMany = jest.fn().mockResolvedValue([{ id: 'silla-1', nombre: 'Silla 1' }]);
    prisma.silla.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.turno.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    // Se neutraliza programar(): esta prueba solo verifica CON QUÉ argumentos
    // se lo llama tras una asignación exitosa; el disparo real del timer al
    // vencer ya se prueba de forma directa y aislada en el describe de
    // expirarVentanaConfirmacion, y en la prueba de arriba para el catch de
    // programar() (sin encadenar una segunda ronda de asignación real).
    const spyProgramar = jest.spyOn(servicio as any, 'programar').mockImplementation(() => undefined);

    await servicio.intentarAsignar();

    expect(spyProgramar).toHaveBeenCalledWith('turno-1', expect.any(Date), expect.any(Function));
  });
});
