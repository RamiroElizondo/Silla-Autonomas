import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShellyService } from '../src/shelly/shelly.service';

const SECRETO = 'secreto-e2e-admin-sesion';
const IP = '50.50.50.50';
const EMAIL = 'admin@ejemplo.com';
const PASSWORD = 'password-correcta';

/**
 * Mock con estado real de UsuarioAdmin (no solo jest.fn() sueltos): hace
 * falta para probar que `logout` (tokenVersion++) efectivamente invalida un
 * token viejo en un `findUnique` posterior — algo que un mock sin memoria no
 * puede demostrar.
 */
function crearPrismaMock(passwordHash: string) {
  const usuario = {
    id: 'u1',
    email: EMAIL,
    passwordHash,
    tokenVersion: 0,
    ultimoLogin: null as Date | null,
  };

  return {
    sesion: { findMany: jest.fn().mockResolvedValue([]) },
    turno: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    silla: { findMany: jest.fn().mockResolvedValue([]) },
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
  };
}

function crearShellyMock() {
  return {
    listarDispositivos: jest.fn().mockResolvedValue([]),
    setRele: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Sesión de admin: cookie/JWT, /me, /logout (Bloque A)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.PROXY_SHARED_SECRET = SECRETO;
    process.env.JWT_SECRET = 'test-secret-admin-sesion';
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
  });

  afterAll(async () => {
    await app.close();
  });

  function login() {
    return request(app.getHttpServer())
      .post('/admin/auth/login')
      .set({ 'x-client-ip': IP, 'x-proxy-secret': SECRETO })
      .send({ email: EMAIL, password: PASSWORD });
  }

  it('login con credenciales correctas devuelve un token', async () => {
    const res = await login();
    expect(res.status).toBeLessThan(300);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(10);
  });

  it('GET /admin/auth/me sin token: 401', async () => {
    const res = await request(app.getHttpServer()).get('/admin/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /admin/auth/me con el token del login: 200 con el usuario', async () => {
    const { body } = await login();
    const res = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Authorization', `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'u1', email: EMAIL });
  });

  it('logout invalida el token: usarlo después en /me da 401', async () => {
    const { body } = await login();
    const token = body.token as string;

    const antes = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(antes.status).toBe(200);

    const logout = await request(app.getHttpServer())
      .post('/admin/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBeLessThan(300);

    const despues = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(despues.status).toBe(401);
  });

  it('un login nuevo después del logout emite un token válido de nuevo', async () => {
    const res = await login();
    const me = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it('POST /admin/auth/logout sin token: 401', async () => {
    const res = await request(app.getHttpServer()).post('/admin/auth/logout');
    expect(res.status).toBe(401);
  });
});
