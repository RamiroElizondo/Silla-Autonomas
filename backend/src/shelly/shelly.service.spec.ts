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
