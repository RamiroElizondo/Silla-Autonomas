import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShellyService } from '../src/shelly/shelly.service';
import { MAX_FALLOS_CANJE } from '../src/common/throttle.config';

const SECRETO = 'secreto-e2e-canje';
const IP = '40.40.40.40';

/**
 * Todo código de vale es "inválido" en este mock: `credito.updateMany`
 * siempre devuelve `count: 0`, así que cada intento de canje entra por la
 * misma rama de fallo que un código adivinado al voleo.
 */
function crearPrismaMock() {
  return {
    sesion: { findMany: jest.fn().mockResolvedValue([]) },
    turno: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    silla: { findMany: jest.fn().mockResolvedValue([]) },
    usuarioAdmin: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    credito: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

/**
 * Storage de throttler que nunca bloquea: el 5/min de `@Throttle` en
 * `/cola/canjear` es harina de otro costal (ya probado en
 * rate-limit.e2e-spec.ts) y no debe interferir con esta prueba puntual del
 * freno de fuerza bruta por vale inválido, que necesita más de 5 intentos
 * seguidos desde la misma IP.
 */
function crearThrottlerStorageMock(): ThrottlerStorage {
  return {
    increment: async () => ({
      totalHits: 1,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
  } as unknown as ThrottlerStorage;
}

function crearShellyMock() {
  return {
    listarDispositivos: jest.fn().mockResolvedValue([]),
    setRele: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Freno de fuerza bruta en /cola/canjear (Hallazgo ALTO 3)', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof crearPrismaMock>;

  beforeAll(async () => {
    process.env.PROXY_SHARED_SECRET = SECRETO;
    process.env.JWT_SECRET = 'test-secret-no-usado';
    process.env.MP_ACCESS_TOKEN = 'test';
    process.env.MP_WEBHOOK_SECRET = 'test';
    process.env.SHELLY_SERVER = 'https://example.invalid';
    process.env.SHELLY_AUTH_KEY = 'test';

    prisma = crearPrismaMock();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ShellyService)
      .useValue(crearShellyMock())
      // El throttle normal de /cola/canjear es 5/min: para poder acumular
      // los MAX_FALLOS_CANJE intentos de este test sin chocar con ese
      // límite (que es harina de otro costal, ya probado en
      // rate-limit.e2e-spec.ts), se reemplaza el guard global por uno que
      // siempre deja pasar.
      .overrideProvider(ThrottlerStorage)
      .useValue(crearThrottlerStorageMock())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function intentoCanje() {
    return request(app.getHttpServer())
      .post('/cola/canjear')
      .set({ 'x-client-ip': IP, 'x-proxy-secret': SECRETO })
      .send({ codigo: 'LUZ-0000' });
  }

  it(`el intento número ${MAX_FALLOS_CANJE + 1} devuelve 429 sin volver a tocar Prisma`, async () => {
    for (let i = 0; i < MAX_FALLOS_CANJE; i++) {
      const r = await intentoCanje();
      expect(r.status).toBe(404); // código inválido -> mismo status siempre
    }

    const llamadasAntes = prisma.credito.updateMany.mock.calls.length;

    const siguiente = await intentoCanje();

    expect(siguiente.status).toBe(429);
    // El bloqueo por IP corta antes de llegar a CreditosService: ni un
    // updateMany más contra la base.
    expect(prisma.credito.updateMany.mock.calls.length).toBe(llamadasAntes);
  });
});
