import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
  it('un hit dentro del TTL no vuelve a llamar al cargador', async () => {
    const cache = new TtlCache<number>(1000);
    const cargador = jest.fn().mockResolvedValue(42);

    const a = await cache.obtenerOCargar('k', cargador);
    const b = await cache.obtenerOCargar('k', cargador);

    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(cargador).toHaveBeenCalledTimes(1);
  });

  it('vencido el TTL, el próximo pedido recarga', async () => {
    jest.useFakeTimers();
    try {
      const cache = new TtlCache<number>(1000);
      const cargador = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const a = await cache.obtenerOCargar('k', cargador);
      jest.advanceTimersByTime(1001);
      const b = await cache.obtenerOCargar('k', cargador);

      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(cargador).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('pedidos concurrentes para la misma key coalescen en una sola llamada al cargador', async () => {
    const cache = new TtlCache<number>(1000);
    let resolver!: (v: number) => void;
    const enVuelo = new Promise<number>((resolve) => {
      resolver = resolve;
    });
    const cargador = jest.fn().mockReturnValue(enVuelo);

    const pedidos = [
      cache.obtenerOCargar('k', cargador),
      cache.obtenerOCargar('k', cargador),
      cache.obtenerOCargar('k', cargador),
      cache.obtenerOCargar('k', cargador),
      cache.obtenerOCargar('k', cargador),
    ];

    expect(cargador).toHaveBeenCalledTimes(1);
    resolver(7);
    const resultados = await Promise.all(pedidos);

    expect(resultados).toEqual([7, 7, 7, 7, 7]);
    expect(cargador).toHaveBeenCalledTimes(1);
  });

  it('invalidar() fuerza una recarga en el próximo pedido', async () => {
    const cache = new TtlCache<number>(60_000);
    const cargador = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const a = await cache.obtenerOCargar('k', cargador);
    cache.invalidar('k');
    const b = await cache.obtenerOCargar('k', cargador);

    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(cargador).toHaveBeenCalledTimes(2);
  });

  it('un cargador que rechaza no queda cacheado: el próximo pedido reintenta', async () => {
    const cache = new TtlCache<number>(60_000);
    const cargador = jest
      .fn()
      .mockRejectedValueOnce(new Error('falló'))
      .mockResolvedValueOnce(5);

    await expect(cache.obtenerOCargar('k', cargador)).rejects.toThrow('falló');
    const b = await cache.obtenerOCargar('k', cargador);

    expect(b).toBe(5);
    expect(cargador).toHaveBeenCalledTimes(2);

    // Ese segundo éxito sí queda cacheado normalmente.
    const c = await cache.obtenerOCargar('k', cargador);
    expect(c).toBe(5);
    expect(cargador).toHaveBeenCalledTimes(2);
  });

  it('llamadas concurrentes durante un cargador que termina rechazando reciben todas el rechazo', async () => {
    const cache = new TtlCache<number>(60_000);
    let rechazar!: (e: unknown) => void;
    const enVuelo = new Promise<number>((_resolve, reject) => {
      rechazar = reject;
    });
    const cargador = jest.fn().mockReturnValue(enVuelo);

    const p1 = cache.obtenerOCargar('k', cargador);
    const p2 = cache.obtenerOCargar('k', cargador);
    rechazar(new Error('boom'));

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    expect(cargador).toHaveBeenCalledTimes(1);
  });
});
