import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShellyService } from '../src/shelly/shelly.service';

const SECRETO = 'secreto-e2e-rate-limit';

/**
 * Mock mínimo de PrismaService: solo lo que tocan los onApplicationBootstrap
 * de SesionesService/ColaService y el login del admin. No hay base de datos
 * real en ningún momento de este test.
 */
function crearPrismaMock() {
  return {
    sesion: { findMany: jest.fn().mockResolvedValue([]) },
    turno: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    silla: { findMany: jest.fn().mockResolvedValue([]) },
    usuarioAdmin: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
  };
}

function crearShellyMock() {
  return {
    listarDispositivos: jest.fn().mockResolvedValue([]),
    setRele: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Rate limit por IP real (Hallazgo ALTO 1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.PROXY_SHARED_SECRET = SECRETO;
    process.env.JWT_SECRET = 'test-secret-no-usado';
    process.env.MP_ACCESS_TOKEN = 'test';
    process.env.MP_WEBHOOK_SECRET = 'test';
    process.env.SHELLY_SERVER = 'https://example.invalid';
    process.env.SHELLY_AUTH_KEY = 'test';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(crearPrismaMock())
      .overrideProvider(ShellyService)
      .useValue(crearShellyMock())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // Un email DISTINTO por test (y por debajo de las 10 fallas de
  // LoginBloqueoService, Bloque A): estos tests prueban el throttle por IP,
  // no el bloqueo por cuenta, así que no deben pisarse entre sí ni con ese
  // otro mecanismo.
  function intentoLogin(headers: Record<string, string>, email: string) {
    return request(app.getHttpServer())
      .post('/admin/auth/login')
      .set(headers)
      .send({ email, password: 'cualquiera123' });
  }

  it('dos x-client-ip distintos con secreto válido tienen contadores independientes', async () => {
    const headersA = { 'x-client-ip': '10.10.10.1', 'x-proxy-secret': SECRETO };
    const headersB = { 'x-client-ip': '10.10.10.2', 'x-proxy-secret': SECRETO };
    const email = 'ip-independientes@ejemplo.com';

    for (let i = 0; i < 5; i++) {
      const r = await intentoLogin(headersA, email);
      expect(r.status).not.toBe(429); // credenciales inválidas -> 401, no 429
    }
    const sextaA = await intentoLogin(headersA, email);
    expect(sextaA.status).toBe(429); // A ya gastó su cupo

    const primeraB = await intentoLogin(headersB, email);
    expect(primeraB.status).not.toBe(429); // B tiene su propio contador
  });

  it('mismo secreto ausente: cambiar x-client-ip no evade el límite (cae al socket)', async () => {
    // Sin x-proxy-secret válido, el guard ignora x-client-ip y usa la IP del
    // socket real de la conexión: todas estas requests, aunque digan venir
    // de IPs "distintas", comparten el mismo contador real.
    const email = 'socket-fallback@ejemplo.com';
    for (let i = 0; i < 5; i++) {
      const r = await intentoLogin({ 'x-client-ip': `20.20.20.${i}` }, email);
      expect(r.status).not.toBe(429);
    }
    const sexta = await intentoLogin({ 'x-client-ip': '20.20.20.99' }, email);
    expect(sexta.status).toBe(429);
  });

  it('login llega a 429 en el 6.º intento por IP', async () => {
    const headers = { 'x-client-ip': '30.30.30.30', 'x-proxy-secret': SECRETO };
    const email = 'sexto-intento@ejemplo.com';
    for (let i = 0; i < 5; i++) {
      const r = await intentoLogin(headers, email);
      expect(r.status).not.toBe(429);
    }
    const sexta = await intentoLogin(headers, email);
    expect(sexta.status).toBe(429);
  });
});
