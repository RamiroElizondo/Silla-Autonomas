import { verificarEntornoDeArranque } from './verificar-entorno';

describe('verificarEntornoDeArranque', () => {
  const original = { ...process.env };

  function entornoCompleto() {
    process.env.PROXY_SHARED_SECRET = 'algo-largo';
    process.env.TURNSTILE_SECRET_KEY = 'algo-largo';
    process.env.IP_HASH_SECRET = 'algo-largo';
    process.env.MP_WEBHOOK_SECRET = 'algo-largo';
  }

  afterEach(() => {
    process.env = { ...original };
  });

  describe('PROXY_SHARED_SECRET', () => {
    it('en producción sin PROXY_SHARED_SECRET, falla al arrancar', () => {
      process.env.NODE_ENV = 'production';
      entornoCompleto();
      delete process.env.PROXY_SHARED_SECRET;
      expect(() => verificarEntornoDeArranque()).toThrow(/PROXY_SHARED_SECRET/);
    });

    it('en desarrollo sin PROXY_SHARED_SECRET, solo avisa (no falla)', () => {
      process.env.NODE_ENV = 'development';
      entornoCompleto();
      delete process.env.PROXY_SHARED_SECRET;
      expect(() => verificarEntornoDeArranque()).not.toThrow();
    });
  });

  describe('TURNSTILE_SECRET_KEY', () => {
    it('en producción sin TURNSTILE_SECRET_KEY, falla al arrancar', () => {
      process.env.NODE_ENV = 'production';
      entornoCompleto();
      delete process.env.TURNSTILE_SECRET_KEY;
      expect(() => verificarEntornoDeArranque()).toThrow(/TURNSTILE_SECRET_KEY/);
    });

    it('en desarrollo sin TURNSTILE_SECRET_KEY, solo avisa (no falla)', () => {
      process.env.NODE_ENV = 'development';
      entornoCompleto();
      delete process.env.TURNSTILE_SECRET_KEY;
      expect(() => verificarEntornoDeArranque()).not.toThrow();
    });
  });

  describe('IP_HASH_SECRET', () => {
    it('en producción sin IP_HASH_SECRET, falla al arrancar', () => {
      process.env.NODE_ENV = 'production';
      entornoCompleto();
      delete process.env.IP_HASH_SECRET;
      expect(() => verificarEntornoDeArranque()).toThrow(/IP_HASH_SECRET/);
    });

    it('en desarrollo sin IP_HASH_SECRET, solo avisa (no falla)', () => {
      process.env.NODE_ENV = 'development';
      entornoCompleto();
      delete process.env.IP_HASH_SECRET;
      expect(() => verificarEntornoDeArranque()).not.toThrow();
    });
  });

  describe('MP_WEBHOOK_SECRET', () => {
    it('en producción sin MP_WEBHOOK_SECRET, falla al arrancar', () => {
      process.env.NODE_ENV = 'production';
      entornoCompleto();
      delete process.env.MP_WEBHOOK_SECRET;
      expect(() => verificarEntornoDeArranque()).toThrow(/MP_WEBHOOK_SECRET/);
    });

    it('en producción sin MP_WEBHOOK_SECRET, falla aunque esté MP_WEBHOOK_ALLOW_UNSIGNED=true', () => {
      // La bandera de escape solo se respeta fuera de producción (ver
      // MercadoPagoService); en producción, sin secreto, el arranque debe
      // abortar igual.
      process.env.NODE_ENV = 'production';
      entornoCompleto();
      delete process.env.MP_WEBHOOK_SECRET;
      process.env.MP_WEBHOOK_ALLOW_UNSIGNED = 'true';
      expect(() => verificarEntornoDeArranque()).toThrow(/MP_WEBHOOK_SECRET/);
    });

    it('en desarrollo sin MP_WEBHOOK_SECRET, solo avisa (no falla)', () => {
      process.env.NODE_ENV = 'development';
      entornoCompleto();
      delete process.env.MP_WEBHOOK_SECRET;
      expect(() => verificarEntornoDeArranque()).not.toThrow();
    });
  });

  it('en producción con todo configurado, no falla', () => {
    process.env.NODE_ENV = 'production';
    entornoCompleto();
    expect(() => verificarEntornoDeArranque()).not.toThrow();
  });
});
