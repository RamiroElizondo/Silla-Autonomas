import { ShellyService } from './shelly.service';

function crearPrismaMock() {
  return { silla: { findMany: jest.fn().mockResolvedValue([]) } } as any;
}

function crearConfigMock(env: Record<string, string>) {
  return { get: (clave: string, def = '') => env[clave] ?? def } as any;
}

describe('ShellyService — bloque de loadtest (LOADTEST=true)', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('setRele no debería llamar a fetch en modo LOADTEST');
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function crearServicioLoadtest() {
    const config = crearConfigMock({
      SHELLY_SERVER: 'https://shelly-XX-eu.shelly.cloud',
      SHELLY_AUTH_KEY: 'auth-key-de-test',
      LOADTEST: 'true',
    });
    return new ShellyService(config, crearPrismaMock());
  }

  it('setRele(ON) resuelve sin llamar a la Shelly Cloud API real', async () => {
    const shelly = crearServicioLoadtest();
    await expect(shelly.setRele('device-1', true, 600)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('setRele(OFF) resuelve sin llamar a la Shelly Cloud API real', async () => {
    const shelly = crearServicioLoadtest();
    await expect(shelly.setRele('device-1', false)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin LOADTEST, setRele sí intenta la llamada HTTP real (y propaga el error de red)', async () => {
    const config = crearConfigMock({
      SHELLY_SERVER: 'https://shelly-XX-eu.shelly.cloud',
      SHELLY_AUTH_KEY: 'auth-key-de-test',
    });
    const shelly = new ShellyService(config, crearPrismaMock());

    await expect(shelly.setRele('device-1', true)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('ShellyService — reintento ante rate limit (429)', () => {
  let fetchSpy: jest.SpyInstance;

  const rateLimit = () =>
    Promise.resolve({
      ok: false,
      status: 200,
      text: async () =>
        JSON.stringify({
          error: 'TOO_MANY_REQUESTS',
          data: { messages: ['Too many requests. Please try again later.'] },
        }),
    } as any);
  const ok = () =>
    Promise.resolve({ ok: true, status: 200, text: async () => '{}' } as any);

  function crear() {
    const shelly = new ShellyService(
      crearConfigMock({
        SHELLY_SERVER: 'https://shelly-XX-eu.shelly.cloud',
        SHELLY_AUTH_KEY: 'auth-key-de-test',
      }),
      crearPrismaMock(),
    );
    (shelly as any).esperaReintentoMs = 0;
    return shelly;
  }

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  it('un 429 puntual se reintenta y el ON termina bien', async () => {
    fetchSpy.mockImplementationOnce(rateLimit).mockImplementationOnce(ok);
    await expect(crear().setRele('device-1', true, 600)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('si el 429 persiste, falla después de 3 intentos', async () => {
    fetchSpy.mockImplementation(rateLimit);
    await expect(crear().setRele('device-1', true)).rejects.toThrow(/TOO_MANY_REQUESTS/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('otros errores (ej. DEVICE_OFFLINE) no se reintentan', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 200,
        text: async () => JSON.stringify({ error: 'DEVICE_OFFLINE' }),
      } as any),
    );
    await expect(crear().setRele('device-1', true)).rejects.toThrow(/DEVICE_OFFLINE/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Un Shelly que se queda sin luz no avisa que se desconecta: la nube sigue
 * sirviendo su última foto de estado, con `cloud.connected: true` y el relé
 * encendido. Lo único que refleja el corte es el flag `online` del envoltorio.
 */
describe('ShellyService — detección de equipo sin conexión', () => {
  const shelly = new ShellyService(
    crearConfigMock({ SHELLY_SERVER: 'https://x', SHELLY_AUTH_KEY: 'k' }),
    crearPrismaMock(),
  );
  const parsear = (dev: any) => (shelly as any).parsearDispositivo(dev);

  it('online 0 con status viejo que dice cloud.connected: true → offline', () => {
    const estado = parsear({
      id: 'dev-1',
      online: 0,
      gen: 'G2',
      status: { cloud: { connected: true }, 'switch:0': { output: true } },
    });
    expect(estado.online).toBe(false);
  });

  it('online 1 → online', () => {
    const estado = parsear({
      id: 'dev-1',
      online: 1,
      gen: 'G2',
      status: { cloud: { connected: true }, 'switch:0': { output: false } },
    });
    expect(estado.online).toBe(true);
    expect(estado.releEncendido).toBe(false);
  });
});
