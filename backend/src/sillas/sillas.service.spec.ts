import { NotFoundException } from '@nestjs/common';
import { SillasService } from './sillas.service';

function crearServicio(
  opciones: {
    silla?: Record<string, unknown> | null;
    sesion?: Record<string, unknown> | null;
    sinEnergia?: boolean;
  } = {},
) {
  const sillaDefault = {
    id: 'silla-1',
    nombre: 'Silla 1',
    estado: 'LIBRE',
    opcion1DuracionMin: 5,
    opcion1Precio: 500,
    opcion2DuracionMin: 10,
    opcion2Precio: 1000,
    finSesionActual: null,
  };
  const findUnique = jest
    .fn()
    .mockResolvedValue(opciones.silla === undefined ? sillaDefault : opciones.silla);

  const prisma: any = {
    silla: { findUnique },
    sesion: { findFirst: jest.fn().mockResolvedValue(opciones.sesion ?? null) },
  };
  const heartbeat: any = { estaOffline: jest.fn().mockReturnValue(opciones.sinEnergia ?? false) };

  const servicio = new SillasService(prisma, heartbeat);
  return { servicio, prisma, heartbeat, findUnique };
}

describe('SillasService — cache TTL de estado (Bloque C)', () => {
  it('dos llamadas a obtener() dentro del TTL solo pegan una vez a la base', async () => {
    const { servicio, findUnique } = crearServicio();

    await servicio.obtener('silla-1');
    await servicio.obtener('silla-1');

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidarCache() fuerza que la siguiente lectura vuelva a pegarle a la base', async () => {
    const { servicio, findUnique } = crearServicio();

    await servicio.obtener('silla-1');
    servicio.invalidarCache('silla-1');
    await servicio.obtener('silla-1');

    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('silla inexistente: NotFoundException y no queda cacheado el resultado nulo indefinidamente', async () => {
    const { servicio, findUnique } = crearServicio({ silla: null });

    await expect(servicio.obtener('no-existe')).rejects.toBeInstanceOf(NotFoundException);
    await expect(servicio.obtener('no-existe')).rejects.toBeInstanceOf(NotFoundException);

    // El null se cachea igual que cualquier otro valor resuelto (no es un
    // rechazo del cargador): dentro del TTL, la segunda llamada no vuelve a
    // pegarle a la base — sigue devolviendo 404 porque el valor cacheado es
    // null, no porque haya reintentado.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('estadoPublico calcula segundosRestantes en vivo, incluso en un hit de cache', async () => {
    const finSesionActual = new Date(Date.now() + 100_000);
    const { servicio } = crearServicio({
      silla: {
        id: 'silla-1',
        nombre: 'Silla 1',
        estado: 'EN_USO',
        opcion1DuracionMin: 5,
        opcion1Precio: 500,
        opcion2DuracionMin: 10,
        opcion2Precio: 1000,
        finSesionActual,
      },
    });

    const primero = await servicio.estadoPublico('silla-1');
    expect(primero.segundosRestantes).toBeGreaterThan(90);
    expect(primero.segundosRestantes).toBeLessThanOrEqual(100);

    // Avanzamos el reloj real 5s sin invalidar la cache: la fila cacheada es
    // la misma, pero segundosRestantes tiene que reflejar el paso del tiempo
    // porque se recalcula en cada llamada, nunca se cachea el valor final.
    const ahoraReal = Date.now;
    jest.spyOn(Date, 'now').mockReturnValue(ahoraReal() + 5000);
    try {
      const segundo = await servicio.estadoPublico('silla-1');
      expect(segundo.segundosRestantes).toBeLessThan(primero.segundosRestantes!);
    } finally {
      jest.spyOn(Date, 'now').mockRestore();
    }
  });

  it('estadoPublico refleja sinEnergia en vivo desde el heartbeat, no desde la fila cacheada', async () => {
    const { servicio, heartbeat } = crearServicio({ sinEnergia: false });

    const primero = await servicio.estadoPublico('silla-1');
    expect(primero.sinEnergia).toBe(false);

    heartbeat.estaOffline.mockReturnValue(true);
    const segundo = await servicio.estadoPublico('silla-1');
    expect(segundo.sinEnergia).toBe(true);
  });
});

describe('SillasService.estadoPublico — gracia de inicio y fase SALIDA', () => {
  const enUso = {
    id: 'silla-1',
    nombre: 'Silla 1',
    estado: 'EN_USO',
    opcion1DuracionMin: 5,
    opcion1Precio: 500,
    opcion2DuracionMin: 10,
    opcion2Precio: 1000,
    finSesionActual: new Date(Date.now() + 620_000),
  };

  it('durante la gracia congela el reloj en la duración y marca fase GRACIA', async () => {
    const { servicio } = crearServicio({
      silla: enUso,
      sesion: {
        estado: 'ACTIVA',
        duracionMin: 10,
        retornoSeg: 40,
        finProgramado: new Date(Date.now() + 620_000),
        salidaHasta: null,
      },
    });

    const r = await servicio.estadoPublico('silla-1');

    expect(r.segundosRestantes).toBe(600);
    expect(r.fase).toBe('GRACIA');
  });

  it('en PAUSA, quien espera ve pausa + retorno juntos (sin salto al pasar a RETORNO)', async () => {
    const { servicio } = crearServicio({
      silla: enUso,
      sesion: {
        estado: 'SALIDA',
        duracionMin: 10,
        retornoSeg: 40,
        finProgramado: new Date(),
        salidaHasta: new Date(Date.now() + 50_000),
      },
    });

    const r = await servicio.estadoPublico('silla-1');

    expect(r.fase).toBe('PAUSA');
    expect(r.segundosSalida).toBe(10);
    expect(r.segundosParaLiberar).toBe(50);
  });

  it('en SALIDA informa la fase y los segundos que faltan', async () => {
    const { servicio } = crearServicio({
      silla: enUso,
      sesion: {
        estado: 'SALIDA',
        duracionMin: 10,
        retornoSeg: 40,
        finProgramado: new Date(),
        salidaHasta: new Date(Date.now() + 30_000),
      },
    });

    const r = await servicio.estadoPublico('silla-1');

    expect(r.estado).toBe('EN_USO');
    expect(r.fase).toBe('RETORNO');
    expect(r.segundosSalida).toBe(30);
    // Para quien espera: pausa + retorno en un solo número.
    expect(r.segundosParaLiberar).toBe(30);
  });
});

describe('SillasService.estadoPublico — opciones de masaje', () => {
  it('libre: publica las dos opciones y la 2 como la seleccionada', async () => {
    const { servicio } = crearServicio();

    const r = await servicio.estadoPublico('silla-1');

    expect(r.opciones).toEqual([
      { opcion: 1, duracionMin: 5, precio: 500 },
      { opcion: 2, duracionMin: 10, precio: 1000 },
    ]);
    expect(r.opcionPorDefecto).toBe(2);
    expect(r.duracionMin).toBe(10);
  });

  it('en uso con la opción 1: duracionMin es la del turno en curso, no la de la opción 2', async () => {
    const { servicio } = crearServicio({
      silla: {
        id: 'silla-1',
        nombre: 'Silla 1',
        estado: 'EN_USO',
        opcion1DuracionMin: 5,
        opcion1Precio: 500,
        opcion2DuracionMin: 10,
        opcion2Precio: 1000,
        finSesionActual: new Date(Date.now() + 200_000),
      },
      sesion: {
        estado: 'ACTIVA',
        duracionMin: 5,
        retornoSeg: 40,
        finProgramado: new Date(Date.now() + 200_000),
        salidaHasta: null,
      },
    });

    const r = await servicio.estadoPublico('silla-1');

    expect(r.duracionMin).toBe(5);
    expect(r.segundosRestantes).toBe(200);
  });
});

describe('SillasService.estadosPublicos — pantalla TV única', () => {
  it('devuelve el estado de cada sillón en el orden de la base (por nombre)', async () => {
    const { servicio, prisma, findUnique } = crearServicio();
    prisma.silla.findMany = jest.fn().mockResolvedValue([{ id: 'silla-a' }, { id: 'silla-b' }]);
    findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve({
        id: where.id,
        nombre: where.id,
        estado: 'LIBRE',
        opcion1DuracionMin: 5,
        opcion1Precio: 500,
        opcion2DuracionMin: 10,
        opcion2Precio: 1000,
        finSesionActual: null,
      }),
    );

    const r = await servicio.estadosPublicos();

    expect(r.map((e) => e.id)).toEqual(['silla-a', 'silla-b']);
    expect(prisma.silla.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ nombre: 'asc' }, { creadaEn: 'asc' }] }),
    );
  });
});
