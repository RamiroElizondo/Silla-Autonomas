import { Logger, NotFoundException } from '@nestjs/common';
import { CreditosService, VIGENCIA_CREDITO_DIAS } from './creditos.service';
import { generarCodigoCredito } from './codigo-credito.util';

jest.mock('./codigo-credito.util', () => ({
  ...jest.requireActual('./codigo-credito.util'),
  generarCodigoCredito: jest.fn(),
}));

const generarCodigoCreditoMock = generarCodigoCredito as jest.Mock;

const MENSAJE_ESPERADO = 'Código inválido o ya utilizado';

describe('CreditosService.tomar — respuesta uniforme (Hallazgo ALTO 3)', () => {
  it('código inexistente: NotFoundException con el mensaje genérico', async () => {
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const servicio = new CreditosService(prisma);

    await expect(servicio.tomar('LUZ-0000')).rejects.toThrow(NotFoundException);
    await expect(servicio.tomar('LUZ-0000')).rejects.toThrow(MENSAJE_ESPERADO);
  });

  it('código ya usado: mismo NotFoundException y mismo mensaje', async () => {
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          estado: 'CANJEADO',
          venceEn: new Date(Date.now() + 60_000),
        }),
      },
    };
    const servicio = new CreditosService(prisma);

    await expect(servicio.tomar('LUZ-1111')).rejects.toThrow(NotFoundException);
    await expect(servicio.tomar('LUZ-1111')).rejects.toThrow(MENSAJE_ESPERADO);
  });

  it('código vencido: mismo NotFoundException y mismo mensaje, y lo marca VENCIDO internamente', async () => {
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'c2',
          estado: 'DISPONIBLE',
          venceEn: new Date(Date.now() - 60_000),
        }),
      },
    };

    const servicio = new CreditosService(prisma);

    await expect(servicio.tomar('LUZ-2222')).rejects.toThrow(NotFoundException);
    await expect(servicio.tomar('LUZ-2222')).rejects.toThrow(MENSAJE_ESPERADO);

    // Se le da tiempo al fire-and-forget interno (registrarIntentoFallido)
    // de correr antes de verificar que marcó el vencimiento.
    await new Promise((r) => setTimeout(r, 10));
    expect(prisma.credito.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'c2', estado: 'DISPONIBLE' }),
        data: expect.objectContaining({ estado: 'VENCIDO' }),
      }),
    );
  });

  it('código válido: lo marca CANJEADO y devuelve el crédito', async () => {
    const creditoCanjeado = { id: 'c3', codigo: 'LUZ-3333', estado: 'CANJEADO' };
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(creditoCanjeado),
      },
    };
    const servicio = new CreditosService(prisma);

    const resultado = await servicio.tomar('LUZ-3333');

    expect(resultado).toBe(creditoCanjeado);
    expect(prisma.credito.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ codigo: 'LUZ-3333', estado: 'DISPONIBLE' }),
        data: expect.objectContaining({ estado: 'CANJEADO' }),
      }),
    );
  });

  it('dos canjes concurrentes del mismo código: solo uno tiene éxito', async () => {
    // Simula la semántica real de un UPDATE condicional en la base: el
    // primero que llega matchea `estado: DISPONIBLE` y lo cambia; el
    // segundo ya no matchea nada.
    let disponible = true;
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockImplementation(async () => {
          if (disponible) {
            disponible = false;
            return { count: 1 };
          }
          return { count: 0 };
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'c4', estado: 'CANJEADO' }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'c4',
          estado: 'CANJEADO',
          venceEn: new Date(Date.now() + 60_000),
        }),
      },
    };
    const servicio = new CreditosService(prisma);

    const resultados = await Promise.allSettled([
      servicio.tomar('LUZ-4444'),
      servicio.tomar('LUZ-4444'),
    ]);

    const exitos = resultados.filter((r) => r.status === 'fulfilled');
    const fallos = resultados.filter((r) => r.status === 'rejected');
    expect(exitos).toHaveLength(1);
    expect(fallos).toHaveLength(1);
  });
});

describe('CreditosService.emitir', () => {
  beforeEach(() => {
    generarCodigoCreditoMock.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('caso feliz: crea el crédito con el código generado, venceEn correcto y loguea', async () => {
    generarCodigoCreditoMock.mockReturnValue('LUZ-AAAA-AAAA');
    const creditoCreado = { id: 'x1', codigo: 'LUZ-AAAA-AAAA' };
    const prisma: any = {
      credito: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(creditoCreado),
      },
    };
    const servicio = new CreditosService(prisma);
    const prioridadDesde = new Date('2026-01-01T00:00:00Z');

    const antes = Date.now();
    const resultado = await servicio.emitir({
      duracionMin: 10,
      motivo: 'corte de luz',
      sesionOrigenId: 'ses-1',
      prioridadDesde,
    });
    const despues = Date.now();

    expect(resultado).toBe(creditoCreado);
    expect(prisma.credito.create).toHaveBeenCalledTimes(1);
    const args = prisma.credito.create.mock.calls[0][0];
    expect(args.data.codigo).toBe('LUZ-AAAA-AAAA');
    expect(args.data.duracionMin).toBe(10);
    expect(args.data.motivo).toBe('corte de luz');
    expect(args.data.sesionOrigenId).toBe('ses-1');
    expect(args.data.prioridadDesde).toBe(prioridadDesde);

    const margenMs = 5_000;
    const venceEnMs = args.data.venceEn.getTime();
    expect(venceEnMs).toBeGreaterThanOrEqual(
      antes + VIGENCIA_CREDITO_DIAS * 24 * 60 * 60_000 - margenMs,
    );
    expect(venceEnMs).toBeLessThanOrEqual(
      despues + VIGENCIA_CREDITO_DIAS * 24 * 60 * 60_000 + margenMs,
    );

    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('LUZ-AAAA-AAAA'),
    );
  });

  it('colisión de código: reintenta generar hasta encontrar uno libre', async () => {
    // Primer candidato ("AAAA") colisiona con uno existente; el segundo
    // ("BBBB") está libre y es el que finalmente se usa. Un tercer valor
    // mockeado ("CCCC") queda de sobra sin usarse, para confirmar que el
    // loop se detiene apenas encuentra uno libre (no sigue generando).
    generarCodigoCreditoMock
      .mockReturnValueOnce('LUZ-AAAA-AAAA')
      .mockReturnValueOnce('LUZ-BBBB-BBBB')
      .mockReturnValueOnce('LUZ-CCCC-CCCC');
    const prisma: any = {
      credito: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'existente' })
          .mockResolvedValueOnce(null),
        create: jest.fn().mockResolvedValue({ id: 'x2', codigo: 'LUZ-BBBB-BBBB' }),
      },
    };
    const servicio = new CreditosService(prisma);

    const resultado = await servicio.emitir({
      duracionMin: 5,
      motivo: 'test',
      prioridadDesde: new Date(),
    });

    expect(resultado.codigo).toBe('LUZ-BBBB-BBBB');
    expect(generarCodigoCreditoMock).toHaveBeenCalledTimes(2);
    expect(prisma.credito.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.credito.findUnique).toHaveBeenNthCalledWith(1, {
      where: { codigo: 'LUZ-AAAA-AAAA' },
    });
    expect(prisma.credito.findUnique).toHaveBeenNthCalledWith(2, {
      where: { codigo: 'LUZ-BBBB-BBBB' },
    });
    expect(prisma.credito.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ codigo: 'LUZ-BBBB-BBBB' }) }),
    );
  });

  it('agotamiento: si los 20 intentos colisionan, tira error y no crea el crédito', async () => {
    generarCodigoCreditoMock.mockReturnValue('LUZ-CCCC-CCCC');
    const findUnique = jest.fn().mockResolvedValue({ id: 'existente' });
    const create = jest.fn();
    const prisma: any = { credito: { findUnique, create } };
    const servicio = new CreditosService(prisma);

    await expect(
      servicio.emitir({ duracionMin: 10, motivo: 'x', prioridadDesde: new Date() }),
    ).rejects.toThrow('No se pudo generar un código de crédito único');

    expect(generarCodigoCreditoMock).toHaveBeenCalledTimes(20);
    expect(findUnique).toHaveBeenCalledTimes(20);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('CreditosService.vincularTurno', () => {
  it('actualiza el crédito con el turno generado', async () => {
    const prisma: any = { credito: { update: jest.fn().mockResolvedValue(undefined) } };
    const servicio = new CreditosService(prisma);

    await servicio.vincularTurno('cred-1', 'turno-1');

    expect(prisma.credito.update).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
      data: { turnoGeneradoId: 'turno-1' },
    });
  });
});

describe('CreditosService.porSesion', () => {
  it('busca el crédito más reciente emitido por esa sesión', async () => {
    const credito = { id: 'c1', sesionOrigenId: 'ses-1' };
    const prisma: any = { credito: { findFirst: jest.fn().mockResolvedValue(credito) } };
    const servicio = new CreditosService(prisma);

    const resultado = await servicio.porSesion('ses-1');

    expect(resultado).toBe(credito);
    expect(prisma.credito.findFirst).toHaveBeenCalledWith({
      where: { sesionOrigenId: 'ses-1' },
      orderBy: { creadoEn: 'desc' },
    });
  });

  it('devuelve null cuando la sesión no tiene crédito emitido', async () => {
    const prisma: any = { credito: { findFirst: jest.fn().mockResolvedValue(null) } };
    const servicio = new CreditosService(prisma);

    const resultado = await servicio.porSesion('ses-2');

    expect(resultado).toBeNull();
  });
});

describe('CreditosService.listar', () => {
  function prismaListado(items: unknown[] = [], total = 0) {
    const findMany = jest.fn().mockReturnValue('findMany-query');
    const count = jest.fn().mockReturnValue('count-query');
    const $transaction = jest.fn().mockResolvedValue([items, total]);
    return { credito: { findMany, count }, $transaction } as any;
  }

  it('usa take=50 y skip=0 por defecto, con el orderBy e include del panel admin', async () => {
    const prisma = prismaListado();
    const servicio = new CreditosService(prisma);

    await servicio.listar();

    expect(prisma.credito.findMany).toHaveBeenCalledWith({
      take: 50,
      skip: 0,
      orderBy: [{ estado: 'asc' }, { creadoEn: 'desc' }],
      include: {
        sesionOrigen: { select: { id: true, silla: { select: { nombre: true } } } },
        turnoGenerado: { select: { id: true, codigo: true, estado: true } },
      },
    });
  });

  it('respeta take y skip explícitos', async () => {
    const prisma = prismaListado();
    const servicio = new CreditosService(prisma);

    await servicio.listar(10, 20);

    expect(prisma.credito.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 20 }),
    );
  });

  it('devuelve { total, items } leyendo ambos en una sola transacción', async () => {
    const prisma = prismaListado([{ id: 'c1' }], 37);
    const servicio = new CreditosService(prisma);

    const resultado = await servicio.listar(10, 30);

    expect(prisma.$transaction).toHaveBeenCalledWith(['findMany-query', 'count-query']);
    expect(resultado).toEqual({ total: 37, items: [{ id: 'c1' }] });
  });
});

describe('CreditosService.vencerCaducados', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sin vencidos (count 0): actualiza pero no loguea', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const prisma: any = {
      credito: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const servicio = new CreditosService(prisma);

    await servicio.vencerCaducados();

    expect(prisma.credito.updateMany).toHaveBeenCalledWith({
      where: { estado: 'DISPONIBLE', venceEn: { lte: expect.any(Date) } },
      data: { estado: 'VENCIDO' },
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('con vencidos (count > 0): loguea cuántos créditos venció', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const prisma: any = {
      credito: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
    const servicio = new CreditosService(prisma);

    await servicio.vencerCaducados();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('3 crédito'));
  });
});
