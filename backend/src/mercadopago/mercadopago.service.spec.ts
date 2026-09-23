import { createHmac } from 'node:crypto';
import { Payment, Preference } from 'mercadopago';
import { MercadoPagoService } from './mercadopago.service';

const SECRETO = 'secreto-de-test-para-webhook';

function firmar(params: { dataId?: string; xRequestId?: string; ts: string }) {
  let manifest = '';
  if (params.dataId) manifest += `id:${params.dataId.toLowerCase()};`;
  if (params.xRequestId) manifest += `request-id:${params.xRequestId};`;
  manifest += `ts:${params.ts};`;
  return createHmac('sha256', SECRETO).update(manifest).digest('hex');
}

function crearServicio(env: Record<string, string>) {
  const config: any = { get: (clave: string, def = '') => env[clave] ?? def };
  return new MercadoPagoService(config);
}

describe('MercadoPagoService.validarFirma (Hallazgo ALTO 4)', () => {
  const ts = '1700000000';
  const dataId = '123456789';
  const xRequestId = 'req-abc-123';

  it('con firma válida, acepta', () => {
    const servicio = crearServicio({ MP_WEBHOOK_SECRET: SECRETO });
    const v1 = firmar({ dataId, xRequestId, ts });

    expect(
      servicio.validarFirma({
        xSignature: `ts=${ts},v1=${v1}`,
        xRequestId,
        dataId,
      }),
    ).toBe(true);
  });

  it('con firma que no coincide, rechaza', () => {
    const servicio = crearServicio({ MP_WEBHOOK_SECRET: SECRETO });
    const v1Ajeno = firmar({ dataId: 'otro-id', xRequestId, ts });

    expect(
      servicio.validarFirma({
        xSignature: `ts=${ts},v1=${v1Ajeno}`,
        xRequestId,
        dataId,
      }),
    ).toBe(false);
  });

  it('sin header x-signature, rechaza', () => {
    const servicio = crearServicio({ MP_WEBHOOK_SECRET: SECRETO });
    expect(
      servicio.validarFirma({ xSignature: undefined, xRequestId, dataId }),
    ).toBe(false);
  });

  describe('parsing estricto de x-signature', () => {
    const casos: Array<[string, string]> = [
      ['sin "=" en un campo', `ts,v1=${'a'.repeat(64)}`],
      ['campo vacío (ts vacío)', `ts=,v1=${'a'.repeat(64)}`],
      ['campo vacío (v1 vacío)', `ts=${ts},v1=`],
      ['clave duplicada', `ts=${ts},ts=999,v1=${'a'.repeat(64)}`],
      ['falta ts', `v1=${'a'.repeat(64)}`],
      ['falta v1', `ts=${ts}`],
      ['v1 no es hex de 64 caracteres (corto)', `ts=${ts},v1=abc123`],
      ['v1 no es hex de 64 caracteres (con caracteres no-hex)', `ts=${ts},v1=${'z'.repeat(64)}`],
      ['completamente vacío', ''],
    ];

    it.each(casos)('%s → rechaza sin tirar excepción', (_nombre, header) => {
      const servicio = crearServicio({ MP_WEBHOOK_SECRET: SECRETO });
      expect(() =>
        servicio.validarFirma({ xSignature: header, xRequestId, dataId }),
      ).not.toThrow();
      expect(
        servicio.validarFirma({ xSignature: header, xRequestId, dataId }),
      ).toBe(false);
    });
  });

  describe('sin MP_WEBHOOK_SECRET configurado (falla cerrado por defecto)', () => {
    it('rechaza todo si no se puso MP_WEBHOOK_ALLOW_UNSIGNED', () => {
      const servicio = crearServicio({});
      const v1 = firmar({ dataId, xRequestId, ts });
      expect(
        servicio.validarFirma({ xSignature: `ts=${ts},v1=${v1}`, xRequestId, dataId }),
      ).toBe(false);
      // Incluso sin ningún header, sigue siendo un "rechazo", no una excepción.
      expect(
        servicio.validarFirma({ xSignature: undefined, xRequestId, dataId }),
      ).toBe(false);
    });

    it('con MP_WEBHOOK_ALLOW_UNSIGNED=true, acepta sin exigir firma', () => {
      const servicio = crearServicio({ MP_WEBHOOK_ALLOW_UNSIGNED: 'true' });
      expect(
        servicio.validarFirma({ xSignature: undefined, xRequestId, dataId }),
      ).toBe(true);
    });
  });

  it('nunca loguea el HMAC esperado, el recibido ni la longitud del secreto', () => {
    const { Logger } = require('@nestjs/common');
    const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const servicio = crearServicio({ MP_WEBHOOK_SECRET: SECRETO });
    const v1Ajeno = firmar({ dataId: 'otro-id', xRequestId, ts });
    servicio.validarFirma({ xSignature: `ts=${ts},v1=${v1Ajeno}`, xRequestId, dataId });

    const textos = spy.mock.calls.map((c) => String(c[0]));
    for (const texto of textos) {
      expect(texto).not.toMatch(/secretLen/i);
      expect(texto).not.toContain(v1Ajeno);
      expect(texto).not.toContain(SECRETO);
    }

    spy.mockRestore();
  });
});


describe('MercadoPagoService — bloque de loadtest (LOADTEST=true)', () => {
  let crearSpy: jest.SpyInstance;
  let getSpy: jest.SpyInstance;

  beforeEach(() => {
    // Espiamos los métodos reales del SDK para confirmar que, en modo
    // LOADTEST, nunca se los llama — sin esto el test podría pasar "de
    // casualidad" si el mock simulado igual devuelve algo con la forma
    // esperada.
    crearSpy = jest.spyOn(Preference.prototype, 'create').mockResolvedValue({
      id: 'no-deberia-usarse',
      init_point: 'https://mercadopago.example/no-deberia-usarse',
    } as any);
    getSpy = jest.spyOn(Payment.prototype, 'get').mockResolvedValue({
      id: 0,
      status: 'no-deberia-usarse',
    } as any);
  });

  afterEach(() => {
    crearSpy.mockRestore();
    getSpy.mockRestore();
  });

  function crearServicioLoadtest() {
    const config: any = {
      get: (clave: string, def = '') =>
        clave === 'LOADTEST' ? 'true' : (def as string),
    };
    return new MercadoPagoService(config);
  }

  describe('crearPreferencia', () => {
    it('no llama al SDK real de Mercado Pago', async () => {
      const servicio = crearServicioLoadtest();
      await servicio.crearPreferencia({
        titulo: 'Silla 1 — 10 min de masaje',
        precio: 3000,
        externalReference: 'ref-123|silla-1',
        itemId: 'silla-1',
        successUrl: 'https://front.example/exito',
        failureUrl: 'https://front.example/fracaso',
        pendingUrl: 'https://front.example/fracaso',
      });
      expect(crearSpy).not.toHaveBeenCalled();
    });

    it('devuelve un resultado simulado con la forma esperada', async () => {
      const servicio = crearServicioLoadtest();
      const resultado = await servicio.crearPreferencia({
        titulo: 'Silla 1 — 10 min de masaje',
        precio: 3000,
        externalReference: 'ref-123|silla-1',
        itemId: 'silla-1',
        successUrl: 'https://front.example/exito',
        failureUrl: 'https://front.example/fracaso',
        pendingUrl: 'https://front.example/fracaso',
      });
      expect(resultado.id).toMatch(/^loadtest-pref-/);
      expect(resultado.initPoint).toBe('https://loadtest.local/fake-checkout');
    });

    it('cada llamada devuelve un id de preferencia distinto', async () => {
      const servicio = crearServicioLoadtest();
      const params = {
        titulo: 'x',
        precio: 1,
        externalReference: 'ref|silla',
        itemId: 'silla',
        successUrl: 'https://front.example/exito',
        failureUrl: 'https://front.example/fracaso',
        pendingUrl: 'https://front.example/fracaso',
      };
      const a = await servicio.crearPreferencia(params);
      const b = await servicio.crearPreferencia(params);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('obtenerPago', () => {
    it('no llama al SDK real de Mercado Pago', async () => {
      const servicio = crearServicioLoadtest();
      await servicio.obtenerPago('loadtest:ref-123|silla-1:3000');
      expect(getSpy).not.toHaveBeenCalled();
    });

    it('con el esquema loadtest:<externalReference>:<monto>, devuelve un pago aprobado con esos datos', async () => {
      const servicio = crearServicioLoadtest();
      const pago = await servicio.obtenerPago('loadtest:ref-abc|silla-9:4500');

      expect(pago).not.toBeNull();
      expect(pago!.status).toBe('approved');
      expect(pago!.transaction_amount).toBe(4500);
      expect(pago!.external_reference).toBe('ref-abc|silla-9');
      expect(pago!.currency_id).toBe('ARS');
      expect(typeof pago!.id).toBe('number');
    });

    it('con un external_reference que contiene ":" en el monto, usa el último ":" como separador', async () => {
      // externalReference real del sistema es "<uuid>|<sillaId>" (sin ":"),
      // pero el parser usa lastIndexOf(':') a propósito para no depender de
      // eso — este test lo deja explícito.
      const servicio = crearServicioLoadtest();
      const pago = await servicio.obtenerPago('loadtest:algo:con:dos:puntos:1000');
      expect(pago!.external_reference).toBe('algo:con:dos:puntos');
      expect(pago!.transaction_amount).toBe(1000);
    });

    it('con un paymentId que no sigue el esquema, devuelve igual un pago aprobado pero sin external_reference', async () => {
      const servicio = crearServicioLoadtest();
      const pago = await servicio.obtenerPago('123456789');

      expect(pago!.status).toBe('approved');
      expect(pago!.external_reference).toBeNull();
      expect(pago!.transaction_amount).toBe(0);
    });

    it('el mismo paymentId siempre devuelve el mismo id numérico (determinístico)', async () => {
      const servicio = crearServicioLoadtest();
      const a = await servicio.obtenerPago('loadtest:ref|silla:1000');
      const b = await servicio.obtenerPago('loadtest:ref|silla:1000');
      expect(a!.id).toBe(b!.id);
    });
  });
});
