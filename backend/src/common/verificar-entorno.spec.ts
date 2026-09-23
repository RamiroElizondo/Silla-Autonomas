import { Logger } from '@nestjs/common';
import {
  resolverCorsOrigins,
  verificarEntornoDeArranque,
} from './verificar-entorno';

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

  describe('LOADTEST', () => {
    it('en producción con LOADTEST=true, falla al arrancar (sin excepción posible)', () => {
      process.env.NODE_ENV = 'production';
      entornoCompleto();
      process.env.LOADTEST = 'true';
      expect(() => verificarEntornoDeArranque()).toThrow(/LOADTEST/);
    });

    it('fuera de producción con LOADTEST=true, no falla', () => {
      process.env.NODE_ENV = 'development';
      entornoCompleto();
      process.env.LOADTEST = 'true';
      expect(() => verificarEntornoDeArranque()).not.toThrow();
    });

    it('en producción sin LOADTEST (o en "false"), no falla por este chequeo', () => {
      process.env.NODE_ENV = 'production';
      entornoCompleto();
      delete process.env.LOADTEST;
      expect(() => verificarEntornoDeArranque()).not.toThrow();

      process.env.LOADTEST = 'false';
      expect(() => verificarEntornoDeArranque()).not.toThrow();
    });
  });
});


describe('resolverCorsOrigins', () => {
  const original = { ...process.env };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...original };
    warnSpy.mockRestore();
  });

  it('sin CORS_ORIGINS en desarrollo: permisivo (refleja cualquier origen) y avisa', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ORIGINS;

    expect(resolverCorsOrigins()).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CORS_ORIGINS no configurada'));
  });

  it('con CORS_ORIGINS configurada: se parsea en un array recortado', () => {
    process.env.NODE_ENV = 'development';
    process.env.CORS_ORIGINS = ' https://midominio.com , https://www.midominio.com ';

    expect(resolverCorsOrigins()).toEqual([
      'https://midominio.com',
      'https://www.midominio.com',
    ]);
  });

  it('con CORS_ORIGINS configurada en producción: también se parsea (no hace falta NODE_ENV)', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://midominio.com';

    expect(resolverCorsOrigins()).toEqual(['https://midominio.com']);
  });

  it('sin CORS_ORIGINS en producción: falla cerrado (ningún origen permitido) y avisa', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ORIGINS;

    expect(resolverCorsOrigins()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CORS_ORIGINS no configurada en producción'),
    );
  });

  it('CORS_ORIGINS vacía (string en blanco) se trata como no configurada', () => {
    process.env.NODE_ENV = 'development';
    process.env.CORS_ORIGINS = '   ';

    expect(resolverCorsOrigins()).toBe(true);
  });
});
