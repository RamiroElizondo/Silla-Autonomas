import { ConfigService } from '@nestjs/config';
import { TurnstileService } from './turnstile.service';

function configCon(valores: Record<string, string>): ConfigService {
  return {
    get: (clave: string, valorPorDefecto?: string) => valores[clave] ?? valorPorDefecto,
  } as unknown as ConfigService;
}

describe('TurnstileService', () => {
  const fetchOriginal = global.fetch;

  afterEach(() => {
    global.fetch = fetchOriginal;
    jest.restoreAllMocks();
  });

  it('deshabilitado (sin TURNSTILE_SECRET_KEY): siempre ok, no llama a fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const servicio = new TurnstileService(configCon({}));
    const resultado = await servicio.verificar('cualquier-token', '1.2.3.4');

    expect(resultado.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('token válido: siteverify success=true → ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as any;

    const servicio = new TurnstileService(configCon({ TURNSTILE_SECRET_KEY: 'sk' }));
    const resultado = await servicio.verificar('token-valido', '1.2.3.4');

    expect(resultado.ok).toBe(true);
  });

  it('token inválido: siteverify success=false → no ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    }) as any;

    const servicio = new TurnstileService(configCon({ TURNSTILE_SECRET_KEY: 'sk' }));
    const resultado = await servicio.verificar('token-invalido', '1.2.3.4');

    expect(resultado.ok).toBe(false);
  });

  it('sin token: no ok, ni siquiera llama a fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const servicio = new TurnstileService(configCon({ TURNSTILE_SECRET_KEY: 'sk' }));
    const resultado = await servicio.verificar(undefined, '1.2.3.4');

    expect(resultado.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('error de red: falla cerrada (no ok)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any;

    const servicio = new TurnstileService(configCon({ TURNSTILE_SECRET_KEY: 'sk' }));
    const resultado = await servicio.verificar('token', '1.2.3.4');

    expect(resultado.ok).toBe(false);
  });

  it('siteverify responde HTTP no-ok: falla cerrada (no ok)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;

    const servicio = new TurnstileService(configCon({ TURNSTILE_SECRET_KEY: 'sk' }));
    const resultado = await servicio.verificar('token', '1.2.3.4');

    expect(resultado.ok).toBe(false);
  });
});
