import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DispositivoCloud } from '../src/shelly/shelly.service';
import { ShellyService } from '../src/shelly/shelly.service';

const SECRETO = 'secreto-e2e-admin-sillas';
const IP = '60.60.60.60';
const EMAIL = 'admin@ejemplo.com';
const PASSWORD = 'password-correcta';

const DEVICE_ID_VALIDO = 'e4b063f1a2c3';

function crearDispositivoCloud(overrides: Partial<DispositivoCloud> = {}): DispositivoCloud {
  return {
    deviceId: DEVICE_ID_VALIDO,
    online: true,
    modelo: 'Plus 1',
    generacion: 'G3',
    releEncendido: false,
    potenciaW: null,
    temperaturaC: 30,
    midePotencia: false,
    initialState: 'off',
    ...overrides,
  };
}

function crearPrismaMock(passwordHash: string) {
  const usuario = {
    id: 'u1',
    email: EMAIL,
    passwordHash,
    tokenVersion: 0,
    ultimoLogin: null as Date | null,
  };

  const sillaExistente = {
    id: '11111111-1111-1111-1111-111111111111',
    nombre: 'Silla 1',
    precio: 3000,
    duracionMin: 10,
    deviceIdShelly: DEVICE_ID_VALIDO,
    modeloShelly: 'Plus 1',
    estado: 'LIBRE',
  };

  return {
    sesion: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    turno: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    pago: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    silla: {
      findMany: jest.fn().mockResolvedValue([sillaExistente]),
      findFirst: jest.fn().mockResolvedValue(null), // sin duplicado de deviceIdShelly
      findUnique: jest.fn().mockResolvedValue(sillaExistente),
      create: jest.fn((args: any) => Promise.resolve({ id: 'silla-nueva', ...args.data })),
      update: jest.fn((args: any) =>
        Promise.resolve({ ...sillaExistente, ...args.data }),
      ),
    },
    usuarioAdmin: {
      findUnique: jest.fn((args: any) => {
        if (args?.where?.email !== undefined) {
          return Promise.resolve(args.where.email === usuario.email ? { ...usuario } : null);
        }
        if (args?.where?.id !== undefined) {
          return Promise.resolve(args.where.id === usuario.id ? { ...usuario } : null);
        }
        return Promise.resolve(null);
      }),
      update: jest.fn((args: any) => {
        if (args?.data?.tokenVersion?.increment) {
          usuario.tokenVersion += args.data.tokenVersion.increment;
        }
        if (args?.data?.ultimoLogin) usuario.ultimoLogin = args.data.ultimoLogin;
        return Promise.resolve({ ...usuario });
      }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

function crearShellyMock() {
  return {
    listarDispositivos: jest.fn().mockResolvedValue([]),
    setRele: jest.fn().mockResolvedValue(undefined),
    verificarDispositivo: jest.fn().mockResolvedValue(crearDispositivoCloud()),
  };
}

describe('Admin: validación de sillas y paginación (Bloque D)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    process.env.PROXY_SHARED_SECRET = SECRETO;
    process.env.JWT_SECRET = 'test-secret-admin-sillas';
    process.env.JWT_EXPIRES_IN = '8h';
    process.env.MP_ACCESS_TOKEN = 'test';
    process.env.MP_WEBHOOK_SECRET = 'test';
    process.env.SHELLY_SERVER = 'https://example.invalid';
    process.env.SHELLY_AUTH_KEY = 'test';

    const passwordHash = await bcrypt.hash(PASSWORD, 4);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(crearPrismaMock(passwordHash))
      .overrideProvider(ShellyService)
      .useValue(crearShellyMock())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .set({ 'x-client-ip': IP, 'x-proxy-secret': SECRETO })
      .send({ email: EMAIL, password: PASSWORD });
    token = res.body.token;
  });

  afterAll(async () => {
    await app.close();
  });

  function auth(req: request.Test) {
    return req.set('Authorization', `Bearer ${token}`);
  }

  // ── 1. Paginación: take/skip fuera de rango → 400, no 500 ──────────

  describe('paginación', () => {
    it('GET /admin/sesiones?take=-1 → 400', async () => {
      const res = await auth(request(app.getHttpServer()).get('/admin/sesiones?take=-1'));
      expect(res.status).toBe(400);
    });

    it('GET /admin/sesiones?skip=-1 → 400', async () => {
      const res = await auth(
        request(app.getHttpServer()).get('/admin/sesiones?take=10&skip=-1'),
      );
      expect(res.status).toBe(400);
    });

    it('GET /admin/sesiones?take=0 → 400 (take tiene que ser >= 1)', async () => {
      const res = await auth(request(app.getHttpServer()).get('/admin/sesiones?take=0'));
      expect(res.status).toBe(400);
    });

    it('GET /admin/sesiones sin query (defaults) → 200', async () => {
      const res = await auth(request(app.getHttpServer()).get('/admin/sesiones'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 0, items: [] });
    });

    it('GET /admin/creditos?take=-5 → 400', async () => {
      const res = await auth(request(app.getHttpServer()).get('/admin/creditos?take=-5'));
      expect(res.status).toBe(400);
    });

    it('GET /admin/pagos/revision?take=-1 → 400', async () => {
      const res = await auth(
        request(app.getHttpServer()).get('/admin/pagos/revision?take=-1'),
      );
      expect(res.status).toBe(400);
    });

    it('GET /admin/pagos/revision sin query → 200', async () => {
      const res = await auth(request(app.getHttpServer()).get('/admin/pagos/revision'));
      expect(res.status).toBe(200);
    });
  });

  // ── 2. DTOs de Silla más estrictos ──────────────────────────────────

  describe('POST /admin/sillas — validación', () => {
    function payloadValido(overrides: Record<string, unknown> = {}) {
      return {
        nombre: 'Silla 2',
        precio: 3500,
        duracionMin: 10,
        deviceIdShelly: DEVICE_ID_VALIDO,
        ...overrides,
      };
    }

    it('payload válido → 201/200 (regresión: no rompimos el happy path)', async () => {
      const res = await auth(
        request(app.getHttpServer()).post('/admin/sillas').send(payloadValido()),
      );
      expect(res.status).toBeLessThan(300);
      expect(res.body).toMatchObject({ deviceIdShelly: DEVICE_ID_VALIDO });
    });

    it('nombre demasiado largo (> 80) → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .post('/admin/sillas')
          .send(payloadValido({ nombre: 'a'.repeat(81) })),
      );
      expect(res.status).toBe(400);
    });

    it('nombre con espacios se recorta (trim) antes de guardar', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .post('/admin/sillas')
          .send(payloadValido({ nombre: '  Silla con espacios  ' })),
      );
      expect(res.status).toBeLessThan(300);
      expect(res.body.nombre).toBe('Silla con espacios');
    });

    it('precio con 3+ decimales → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .post('/admin/sillas')
          .send(payloadValido({ precio: 3000.999 })),
      );
      expect(res.status).toBe(400);
    });

    it('precio por encima del máximo → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .post('/admin/sillas')
          .send(payloadValido({ precio: 1_000_001 })),
      );
      expect(res.status).toBe(400);
    });

    it('deviceIdShelly con formato inválido (mayúsculas) → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .post('/admin/sillas')
          .send(payloadValido({ deviceIdShelly: 'E4B063F1A2C3' })),
      );
      expect(res.status).toBe(400);
    });

    it('deviceIdShelly con formato inválido (largo distinto de 12) → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .post('/admin/sillas')
          .send(payloadValido({ deviceIdShelly: 'abc123' })),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /admin/sillas/:id — validación (mismas reglas, todo opcional)', () => {
    it('un campo válido a la vez sigue funcionando (regresión)', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .patch('/admin/sillas/11111111-1111-1111-1111-111111111111')
          .send({ precio: 4000 }),
      );
      expect(res.status).toBeLessThan(300);
    });

    it('precio con 3+ decimales → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .patch('/admin/sillas/11111111-1111-1111-1111-111111111111')
          .send({ precio: 10.123 }),
      );
      expect(res.status).toBe(400);
    });

    it('deviceIdShelly con formato inválido → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .patch('/admin/sillas/11111111-1111-1111-1111-111111111111')
          .send({ deviceIdShelly: 'no-es-hex!!' }),
      );
      expect(res.status).toBe(400);
    });

    it('nombre demasiado largo → 400', async () => {
      const res = await auth(
        request(app.getHttpServer())
          .patch('/admin/sillas/11111111-1111-1111-1111-111111111111')
          .send({ nombre: 'a'.repeat(200) }),
      );
      expect(res.status).toBe(400);
    });
  });
});
