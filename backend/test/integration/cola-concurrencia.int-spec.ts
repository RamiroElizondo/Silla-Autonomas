/**
 * Test de integración con Postgres REAL: varias sillas y muchos turnos en
 * cola compitiendo a la vez (ej. 2 sillas, 15 personas).
 *
 * Complementa src/cola/cola-concurrencia.spec.ts (que usa una base en
 * memoria y solo valida la lógica del CAS). Acá los `updateMany`
 * condicionales (`estado: 'LIBRE'` / `estado: 'EN_COLA'`) los resuelve el
 * motor de Postgres de verdad, con transacciones que efectivamente compiten
 * por las mismas filas. Ver el comentario al tope de pagos-race.int-spec.ts
 * para el por qué de un runner aparte y cómo preparar la base
 * (TEST_DATABASE_URL + `prisma migrate deploy`). Correr con `npm run test:int`.
 *
 * NO se ejecutó en el sandbox de desarrollo (no hay Postgres ahí).
 */

import { PrismaClient } from '@prisma/client';
import { ColaService } from '../../src/cola/cola.service';

const N_SILLAS = 2;
const N_TURNOS = 15;
const PREFIJO = `int-cola-${Date.now()}`;

describe('ColaService — varias sillas y muchos turnos a la vez (Postgres real)', () => {
  let prisma: PrismaClient;
  let cola: ColaService;
  let sillaIds: string[] = [];
  let turnoIds: string[] = [];
  // Filas AJENAS a este test que hay que apartar mientras corre: intentarAsignar
  // trabaja sobre TODAS las sillas LIBRE y TODOS los turnos EN_COLA de la base.
  let sillasAjenas: string[] = [];
  let turnosAjenos: string[] = [];

  async function sembrar() {
    sillaIds = [];
    turnoIds = [];
    for (let i = 1; i <= N_SILLAS; i++) {
      const s = await prisma.silla.create({
        data: {
          nombre: `${PREFIJO} silla ${i}`,
          precio: 1000,
          duracionMin: 10,
          deviceIdShelly: 'aabbccddeeff',
        },
      });
      sillaIds.push(s.id);
    }
    const base = Date.now() - 60_000;
    for (let i = 1; i <= N_TURNOS; i++) {
      const t = await prisma.turno.create({
        data: {
          estado: 'EN_COLA',
          externalReference: `${PREFIJO}-${i}`,
          codigo: `${PREFIJO}-${String(i).padStart(2, '0')}`,
          monto: 1000,
          duracionMin: 10,
          pagadoEn: new Date(base + i * 1000), // i=1 es el más viejo
        },
      });
      turnoIds.push(t.id);
    }
  }

  async function apartarAjenos() {
    const sillas = await prisma.silla.findMany({
      where: { estado: 'LIBRE', NOT: { nombre: { startsWith: PREFIJO } } },
      select: { id: true },
    });
    sillasAjenas = sillas.map((s) => s.id);
    await prisma.silla.updateMany({
      where: { id: { in: sillasAjenas }, estado: 'LIBRE' },
      data: { estado: 'FUERA_DE_SERVICIO' },
    });
    const turnos = await prisma.turno.findMany({
      where: { estado: 'EN_COLA', NOT: { externalReference: { startsWith: PREFIJO } } },
      select: { id: true },
    });
    turnosAjenos = turnos.map((t) => t.id);
    await prisma.turno.updateMany({
      where: { id: { in: turnosAjenos }, estado: 'EN_COLA' },
      data: { estado: 'ESPERANDO_PAGO' },
    });
  }

  async function restaurarAjenos() {
    await prisma.silla.updateMany({
      where: { id: { in: sillasAjenas }, estado: 'FUERA_DE_SERVICIO' },
      data: { estado: 'LIBRE' },
    });
    await prisma.turno.updateMany({
      where: { id: { in: turnosAjenos }, estado: 'ESPERANDO_PAGO' },
      data: { estado: 'EN_COLA' },
    });
  }

  async function limpiar() {
    await prisma.turno.deleteMany({ where: { externalReference: { startsWith: PREFIJO } } });
    await prisma.silla.deleteMany({ where: { nombre: { startsWith: PREFIJO } } });
  }

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      // A propósito NO cae a DATABASE_URL: ver pagos-race.int-spec.ts.
      throw new Error(
        'TEST_DATABASE_URL no está configurada. Este test necesita una base Postgres de PRUEBA ' +
          'real (nunca la de desarrollo o producción) con las migraciones aplicadas. Ver el ' +
          'comentario al tope de test/integration/pagos-race.int-spec.ts.',
      );
    }
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();

    const noUsadas: any = {};
    cola = new ColaService(
      prisma as any,
      noUsadas, // mp
      noUsadas, // sesiones
      { estaOffline: () => false } as any, // heartbeat: todas con energía
      noUsadas, // creditos
      noUsadas, // fallosCanje
      noUsadas, // turnstile
      noUsadas, // ipHash
      { invalidarCache: jest.fn() } as any, // sillas
      { get: () => '' } as any, // config
    );
  });

  beforeEach(async () => {
    await limpiar();
    await apartarAjenos();
    await sembrar();
  });

  afterEach(() => {
    // Timers reales de "ventana de confirmación" (2 min) que programa
    // intentarAsignar: si quedan vivos, Jest no termina.
    const timers: Map<string, NodeJS.Timeout> | undefined = (cola as any)?.timers;
    timers?.forEach((t) => clearTimeout(t));
    timers?.clear();
  });

  afterEach(async () => {
    await restaurarAjenos();
  });

  afterAll(async () => {
    if (!prisma) return;
    await limpiar();
    await prisma.$disconnect();
  });

  it('8 intentarAsignar simultáneos con 2 sillas y 15 turnos: exactamente 2 asignados, sin sillas repetidas, los 2 más viejos', async () => {
    await Promise.all(Array.from({ length: 8 }, () => cola.intentarAsignar()));

    const asignados = await prisma.turno.findMany({
      where: { id: { in: turnoIds }, estado: 'ASIGNADO' },
      orderBy: { pagadoEn: 'asc' },
    });
    expect(asignados).toHaveLength(N_SILLAS);
    expect(asignados.map((t) => t.id)).toEqual(turnoIds.slice(0, N_SILLAS));
    expect(new Set(asignados.map((t) => t.sillaId)).size).toBe(N_SILLAS);

    expect(await prisma.turno.count({ where: { id: { in: turnoIds }, estado: 'EN_COLA' } })).toBe(
      N_TURNOS - N_SILLAS,
    );
    expect(await prisma.silla.count({ where: { id: { in: sillaIds }, estado: 'RESERVADA' } })).toBe(
      N_SILLAS,
    );
  });

  it('vaciar la cola liberando las ventanas de a pares: cada turno se asigna una sola vez y en orden FIFO', async () => {
    await Promise.all(Array.from({ length: 4 }, () => cola.intentarAsignar()));

    const vistos: string[] = [];
    for (let ronda = 0; ronda < 12; ronda++) {
      const asignados = await prisma.turno.findMany({
        where: { id: { in: turnoIds }, estado: 'ASIGNADO' },
        orderBy: { pagadoEn: 'asc' },
      });
      if (asignados.length === 0) break;
      vistos.push(...asignados.map((t) => t.id));
      // Vencen las ventanas de las 2 sillas en paralelo → cada una libera su
      // silla y reintenta asignar (dos intentarAsignar más compitiendo).
      await Promise.all(asignados.map((t) => (cola as any).expirarVentanaConfirmacion(t.id)));
    }

    expect(vistos).toEqual(turnoIds); // los 15, sin repetir, en orden
    expect(await prisma.turno.count({ where: { id: { in: turnoIds }, estado: 'CANCELADA' } })).toBe(
      N_TURNOS,
    );
    expect(await prisma.silla.count({ where: { id: { in: sillaIds }, estado: 'LIBRE' } })).toBe(
      N_SILLAS,
    );
  });
});
