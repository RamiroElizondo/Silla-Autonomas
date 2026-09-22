import { createHmac } from 'node:crypto';
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
