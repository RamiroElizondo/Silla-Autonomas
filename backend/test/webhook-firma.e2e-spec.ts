import { createHmac } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PagosService } from '../src/pagos/pagos.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShellyService } from '../src/shelly/shelly.service';

const SECRETO = 'secreto-e2e-webhook';

function crearPrismaMock() {
  return {
    sesion: { findMany: jest.fn().mockResolvedValue([]) },
    turno: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    silla: { findMany: jest.fn().mockResolvedValue([]) },
    usuarioAdmin: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
  };
}

function crearShellyMock() {
  return {
    listarDispositivos: jest.fn().mockResolvedValue([]),
    setRele: jest.fn().mockResolvedValue(undefined),
  };
}

function firmar(params: { dataId: string; xRequestId: string; ts: string }) {
  const manifest =
    `id:${params.dataId.toLowerCase()};` +
    `request-id:${params.xRequestId};` +
    `ts:${params.ts};`;
  return createHmac('sha256', SECRETO).update(manifest).digest('hex');
}

describe('Webhook de Mercado Pago — firma (Hallazgo ALTO 4)', () => {
  let app: INestApplication;
  let pagos: { procesarNotificacionPago: jest.Mock };

  beforeAll(async () => {
    process.env.PROXY_SHARED_SECRET = 'no-usado-en-este-test';
    process.env.JWT_SECRET = 'test-secret-no-usado';
    process.env.MP_ACCESS_TOKEN = 'test';
    process.env.MP_WEBHOOK_SECRET = SECRETO;
    delete process.env.MP_WEBHOOK_ALLOW_UNSIGNED;
    process.env.SHELLY_SERVER = 'https://example.invalid';
    process.env.SHELLY_AUTH_KEY = 'test';

    pagos = { procesarNotificacionPago: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(crearPrismaMock())
      .overrideProvider(ShellyService)
      .useValue(crearShellyMock())
      .overrideProvider(PagosService)
      .useValue(pagos)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    pagos.procesarNotificacionPago.mockClear();
  });

  it('sin x-signature, rechaza con 403 y no procesa el pago', async () => {
    const r = await request(app.getHttpServer())
      .post('/webhooks/mercadopago')
      .query({ 'data.id': '123', type: 'payment' })
      .send({});

    expect(r.status).toBe(403);
    expect(pagos.procesarNotificacionPago).not.toHaveBeenCalled();
  });

  it('con firma inválida, rechaza con 403 y no procesa el pago', async () => {
    const r = await request(app.getHttpServer())
      .post('/webhooks/mercadopago')
      .query({ 'data.id': '123', type: 'payment' })
      .set('x-signature', `ts=1700000000,v1=${'0'.repeat(64)}`)
      .set('x-request-id', 'req-1')
      .send({});

    expect(r.status).toBe(403);
    expect(pagos.procesarNotificacionPago).not.toHaveBeenCalled();
  });

  it('con firma válida y type=payment, procesa el pago (firma se valida ANTES de tocar la base)', async () => {
    const dataId = '999888777';
    const xRequestId = 'req-valido';
    const ts = String(Math.floor(Date.now() / 1000));
    const v1 = firmar({ dataId, xRequestId, ts });

    const r = await request(app.getHttpServer())
      .post('/webhooks/mercadopago')
      .query({ 'data.id': dataId, type: 'payment' })
      .set('x-signature', `ts=${ts},v1=${v1}`)
      .set('x-request-id', xRequestId)
      .send({});

    expect(r.status).toBe(200);
    // procesarNotificacionPago es fire-and-forget desde el controller: le
    // damos una vuelta de microtareas antes de verificar que se llamó.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pagos.procesarNotificacionPago).toHaveBeenCalledWith(dataId, expect.anything());
  });

  it('una notificación IPN vieja (topic sin type) se ignora sin exigir firma', async () => {
    const r = await request(app.getHttpServer())
      .post('/webhooks/mercadopago')
      .query({ topic: 'merchant_order', id: '555' })
      .send({});

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recibido: true });
    expect(pagos.procesarNotificacionPago).not.toHaveBeenCalled();
  });
});
