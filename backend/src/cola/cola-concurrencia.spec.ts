import { ColaService } from './cola.service';

/**
 * Tests de concurrencia de la cola con VARIAS sillas y MUCHOS clientes a la
 * vez (ej. 2 sillas, 15 personas).
 *
 * Usan una "base" en memoria (FakeDb) en vez de los mocks de un solo valor de
 * cola.service.spec.ts. Cada operación cede el control al event loop antes de
 * ejecutarse (`ceder()`), así que las llamadas concurrentes SE INTERCALAN
 * entre el "leer" y el "escribir", igual que pasaría contra Postgres. Los
 * `updateMany` condicionales (CAS) se evalúan de forma atómica después de
 * ceder, que es lo que garantiza el motor real.
 *
 * Limitación: esto valida la LÓGICA del CAS de ColaService, no el motor de
 * Postgres. Para eso ver test/integration/cola-concurrencia.int-spec.ts.
 */

type EstadoTurno =
  | 'ESPERANDO_PAGO'
  | 'EN_COLA'
  | 'ASIGNADO'
  | 'EN_USO'
  | 'COMPLETADA'
  | 'CANCELADA';
type EstadoSilla = 'LIBRE' | 'RESERVADA' | 'EN_USO' | 'FUERA_DE_SERVICIO' | 'PAGO_PENDIENTE';

interface FakeSilla {
  id: string;
  nombre: string;
  estado: EstadoSilla;
  precio: number;
  duracionMin: number;
}
interface FakeTurno {
  id: string;
  codigo: string | null;
  estado: EstadoTurno;
  sillaId: string | null;
  ipHash: string | null;
  pagadoEn: Date | null;
  asignadoEn: Date | null;
  monto: number;
  duracionMin: number;
  externalReference: string;
  [k: string]: any;
}

// Cede el control varias veces: fuerza que las llamadas concurrentes se
// intercalen entre el read y el write.
async function ceder(veces = 3) {
  for (let i = 0; i < veces; i++) await Promise.resolve();
}

function coincide(valor: any, filtro: any): boolean {
  if (filtro && typeof filtro === 'object' && !(filtro instanceof Date)) {
    if ('not' in filtro) return valor !== filtro.not;
    if ('lt' in filtro) return valor != null && valor < filtro.lt;
  }
  return valor === filtro;
}
function cumple(fila: any, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([k, f]) => coincide(fila[k], f));
}

class FakeDb {
  sillas = new Map<string, FakeSilla>();
  turnos = new Map<string, FakeTurno>();
  /** Orden en que se fueron asignando turnos (EN_COLA → ASIGNADO). */
  ordenAsignacion: string[] = [];
  private seq = 0;

  agregarSillas(n: number) {
    for (let i = 1; i <= n; i++) {
      this.sillas.set(`silla-${i}`, {
        id: `silla-${i}`,
        nombre: `Silla ${i}`,
        estado: 'LIBRE',
        precio: 1000,
        duracionMin: 10,
      });
    }
  }

  /** n turnos EN_COLA con pagadoEn estrictamente creciente (turno-01 es el más viejo). */
  agregarTurnosEnCola(n: number) {
    const base = Date.UTC(2026, 8, 29, 12, 0, 0);
    for (let i = 1; i <= n; i++) {
      const id = `turno-${String(i).padStart(2, '0')}`;
      this.turnos.set(id, this.nuevoTurno(id, 'EN_COLA', new Date(base + i * 1000)));
    }
  }

  nuevoTurno(id: string, estado: EstadoTurno, pagadoEn: Date | null, extra: Partial<FakeTurno> = {}): FakeTurno {
    return {
      id,
      codigo: pagadoEn ? `COD-${id}` : null,
      estado,
      sillaId: null,
      ipHash: null,
      pagadoEn,
      asignadoEn: null,
      monto: 1000,
      duracionMin: 10,
      externalReference: `turno:${id}`,
      ...extra,
    };
  }

  prisma() {
    const db = this;
    // Simula pg_advisory_xact_lock(hashtext(ip)): las transacciones que piden
    // el mismo lock se ejecutan de a una; el lock se libera al terminar.
    const locks = new Map<string, Promise<unknown>>();
    let claveActual: string | null = null;
    const p: any = {
      $transaction: jest.fn(async (fn: any) => {
        let liberar!: () => void;
        const tx: any = Object.create(p);
        tx.$executeRaw = jest.fn(async (_s: TemplateStringsArray, clave: string) => {
          const previo = locks.get(clave) ?? Promise.resolve();
          const mio = new Promise<void>((r) => (liberar = r));
          locks.set(clave, previo.then(() => mio));
          await previo;
          claveActual = clave;
          return 0;
        });
        try {
          return await fn(tx);
        } finally {
          liberar?.();
        }
      }),
      silla: {
        findMany: jest.fn(async ({ where }: any = {}) => {
          await ceder();
          return [...db.sillas.values()].filter((s) => cumple(s, where)).map((s) => ({ ...s }));
        }),
        count: jest.fn(async ({ where }: any = {}) => {
          await ceder();
          return [...db.sillas.values()].filter((s) => cumple(s, where)).length;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          await ceder();
          let count = 0;
          for (const s of db.sillas.values()) {
            if (cumple(s, where)) {
              Object.assign(s, data);
              count++;
            }
          }
          return { count };
        }),
      },
      turno: {
        create: jest.fn(async ({ data }: any) => {
          await ceder();
          const id = `turno-nuevo-${++db.seq}`;
          const t = db.nuevoTurno(id, 'ESPERANDO_PAGO', null, data);
          db.turnos.set(id, t);
          return { ...t };
        }),
        count: jest.fn(async ({ where }: any = {}) => {
          await ceder();
          return [...db.turnos.values()].filter((t) => cumple(t, where)).length;
        }),
        findUnique: jest.fn(async ({ where }: any) => {
          await ceder();
          const t = [...db.turnos.values()].find((x) => cumple(x, where));
          return t ? { ...t } : null;
        }),
        findFirst: jest.fn(async ({ where, orderBy }: any = {}) => {
          await ceder();
          const lista = [...db.turnos.values()].filter((t) => cumple(t, where));
          if (orderBy?.pagadoEn === 'asc') {
            lista.sort((a, b) => a.pagadoEn!.getTime() - b.pagadoEn!.getTime());
          }
          return lista[0] ? { ...lista[0] } : null;
        }),
        findMany: jest.fn(async ({ where }: any = {}) => {
          await ceder();
          return [...db.turnos.values()].filter((t) => cumple(t, where)).map((t) => ({ ...t }));
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          await ceder();
          let count = 0;
          for (const t of db.turnos.values()) {
            if (cumple(t, where)) {
              Object.assign(t, data);
              count++;
              if (data.estado === 'ASIGNADO') db.ordenAsignacion.push(t.id);
            }
          }
          return { count };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          await ceder();
          const t = db.turnos.get(where.id)!;
          Object.assign(t, data);
          return { ...t };
        }),
      },
      sesion: { count: jest.fn(async () => 0) },
    };
    void claveActual;
    return p;
  }

  turnosEn(estado: EstadoTurno) {
    return [...this.turnos.values()].filter((t) => t.estado === estado);
  }
  sillasEn(estado: EstadoSilla) {
    return [...this.sillas.values()].filter((s) => s.estado === estado);
  }
}

function crear(
  db: FakeDb,
  opciones: { offline?: (id: string) => boolean; turnstileOk?: boolean } = {},
) {
  const prisma = db.prisma();
  const mp: any = {
    crearPreferencia: jest.fn(async () => {
      await ceder();
      return { id: 'p1', initPoint: 'https://mp.test/turno' };
    }),
  };
  const sesiones: any = { activarSesion: jest.fn().mockResolvedValue(undefined) };
  const heartbeat: any = { estaOffline: jest.fn(opciones.offline ?? (() => false)) };
  const creditos: any = {};
  const fallosCanje: any = {};
  const turnstile: any = { verificar: jest.fn().mockResolvedValue({ ok: opciones.turnstileOk ?? true }) };
  const ipHash: any = { hash: jest.fn((ip: string) => `hash:${ip}`) };
  const sillas: any = { invalidarCache: jest.fn() };
  const config: any = { get: () => '' };

  const servicio = new ColaService(
    prisma as any,
    mp,
    sesiones,
    heartbeat,
    creditos,
    fallosCanje,
    turnstile,
    ipHash,
    sillas,
    config,
  );
  return { servicio, prisma, mp, turnstile };
}

/** ids turno-01..turno-NN */
const ids = (desde: number, hasta: number) =>
  Array.from({ length: hasta - desde + 1 }, (_, i) => `turno-${String(desde + i).padStart(2, '0')}`);

describe('ColaService — varias sillas y muchos clientes a la vez', () => {
  beforeEach(() => {
    // Date real (doNotFake) para que pagadoEn distinga turnos; timers falsos
    // para que ningún setTimeout de "ventana de confirmación" quede vivo.
    jest.useFakeTimers({ doNotFake: ['Date'] });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('2 sillas libres y 15 turnos EN_COLA: asigna exactamente 2 (los más viejos) y deja 13 esperando', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    db.agregarTurnosEnCola(15);
    const { servicio } = crear(db);

    await servicio.intentarAsignar();

    expect(db.turnosEn('ASIGNADO').map((t) => t.id).sort()).toEqual(['turno-01', 'turno-02']);
    expect(db.turnosEn('EN_COLA')).toHaveLength(13);
    expect(db.sillasEn('RESERVADA')).toHaveLength(2);
    expect(db.sillasEn('LIBRE')).toHaveLength(0);
    // cada turno asignado tiene una silla distinta
    const sillasAsignadas = db.turnosEn('ASIGNADO').map((t) => t.sillaId);
    expect(new Set(sillasAsignadas).size).toBe(2);
  });

  it('varias ejecuciones concurrentes de intentarAsignar (tick + webhooks): nunca doble asignación', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    db.agregarTurnosEnCola(15);
    const { servicio } = crear(db);

    // 8 disparadores simultáneos: el tick de 5s + varios pagos aprobados.
    await Promise.all(Array.from({ length: 8 }, () => servicio.intentarAsignar()));

    const asignados = db.turnosEn('ASIGNADO');
    expect(asignados).toHaveLength(2);
    expect(new Set(asignados.map((t) => t.sillaId)).size).toBe(2); // ninguna silla repetida
    expect(db.turnosEn('EN_COLA')).toHaveLength(13);
    expect(db.sillasEn('RESERVADA')).toHaveLength(2);
    // Cada turno se marcó ASIGNADO una sola vez en toda la corrida.
    expect(db.ordenAsignacion).toHaveLength(2);
    expect(new Set(db.ordenAsignacion).size).toBe(2);
  });

  it('15 pagos aprobados a la vez con 2 sillas: 2 asignados, 13 en cola, códigos únicos y ninguna silla duplicada', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    for (const id of ids(1, 15)) db.turnos.set(id, db.nuevoTurno(id, 'ESPERANDO_PAGO', null));
    const { servicio } = crear(db);

    const res = await Promise.allSettled(ids(1, 15).map((id) => servicio.procesarPagoAprobado(id)));

    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(db.turnosEn('ESPERANDO_PAGO')).toHaveLength(0);
    expect(db.turnosEn('ASIGNADO')).toHaveLength(2);
    expect(db.turnosEn('EN_COLA')).toHaveLength(13);
    const sillasAsignadas = db.turnosEn('ASIGNADO').map((t) => t.sillaId);
    expect(new Set(sillasAsignadas).size).toBe(2);
    expect(db.sillasEn('RESERVADA')).toHaveLength(2);
  });

  it('el mismo pago aprobado llegando 2 veces en paralelo (webhook + retorno): un turno solo entra una vez a la cola', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    db.turnos.set('turno-01', db.nuevoTurno('turno-01', 'ESPERANDO_PAGO', null));
    const { servicio } = crear(db);

    const res = await Promise.allSettled([
      servicio.procesarPagoAprobado('turno-01'),
      servicio.procesarPagoAprobado('turno-01'),
    ]);

    // Uno gana; el otro recibe Conflict (PagosService lo marca a revisión).
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(db.ordenAsignacion).toEqual(['turno-01']);
  });

  it('respeta FIFO al vaciar la cola: al vencer las ventanas de las 2 sillas van pasando los siguientes por orden de pago', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    db.agregarTurnosEnCola(15);
    const { servicio } = crear(db);

    await Promise.all(Array.from({ length: 4 }, () => servicio.intentarAsignar()));

    // Vencen (no confirman) las ventanas de los que tienen silla, de a pares,
    // hasta vaciar la cola.
    for (let ronda = 0; ronda < 10 && db.turnosEn('ASIGNADO').length > 0; ronda++) {
      const vencidos = db.turnosEn('ASIGNADO').map((t) => t.id);
      await Promise.all(vencidos.map((id) => (servicio as any).expirarVentanaConfirmacion(id)));
    }

    expect(db.ordenAsignacion).toEqual(ids(1, 15)); // cada uno una vez, en orden
    expect(db.turnosEn('CANCELADA')).toHaveLength(15);
    expect(db.sillasEn('LIBRE')).toHaveLength(2);
  });

  it('con 1 de las 2 sillas sin energía, solo se asigna la que sí tiene luz', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    db.agregarTurnosEnCola(15);
    const { servicio } = crear(db, { offline: (id) => id === 'silla-2' });

    await Promise.all([servicio.intentarAsignar(), servicio.intentarAsignar()]);

    const asignados = db.turnosEn('ASIGNADO');
    expect(asignados).toHaveLength(1);
    expect(asignados[0].sillaId).toBe('silla-1');
    expect(db.sillas.get('silla-2')!.estado).toBe('LIBRE');
    expect(db.turnosEn('EN_COLA')).toHaveLength(14);
  });

  it('un turno que se cancela mientras 15 compiten: no queda ninguna silla RESERVADA huérfana', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    db.agregarTurnosEnCola(15);
    const { servicio } = crear(db);

    // turno-01 se cancela (ej. timeout) en medio de las asignaciones.
    const cancelar = (async () => {
      await ceder(4);
      db.turnos.get('turno-01')!.estado = 'CANCELADA';
    })();
    await Promise.all([cancelar, servicio.intentarAsignar(), servicio.intentarAsignar()]);

    const asignados = db.turnosEn('ASIGNADO');
    // RESERVADA <=> hay un turno ASIGNADO con esa silla.
    const reservadas = db.sillasEn('RESERVADA').map((s) => s.id).sort();
    expect(reservadas).toEqual(asignados.map((t) => t.sillaId!).sort());
    expect(asignados.length).toBeLessThanOrEqual(2);
  });

  it('posición en la fila de los 13 que esperan: 0..12 según el orden de pago', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    db.agregarTurnosEnCola(15);
    const { servicio } = crear(db);
    await servicio.intentarAsignar();

    const posiciones: number[] = [];
    for (const id of ids(3, 15)) {
      const est = await servicio.estadoTurno(id);
      posiciones.push(est.posicion as number);
    }
    // posicion = cantidad de turnos EN_COLA con pagadoEn anterior
    expect(posiciones).toEqual(Array.from({ length: 13 }, (_, i) => i));
  });

  it('unirse: 15 personas de IPs distintas a la vez → 15 turnos y 15 preferencias de pago, sin tocar las sillas', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    const { servicio, mp } = crear(db);

    const res = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) => servicio.unirse('https://app.test', 'tok', `10.0.0.${i + 1}`)),
    );

    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(db.turnos.size).toBe(15);
    expect(new Set(db.turnosEn('ESPERANDO_PAGO').map((t) => t.externalReference)).size).toBe(15);
    expect(mp.crearPreferencia).toHaveBeenCalledTimes(15);
    expect(db.sillasEn('LIBRE')).toHaveLength(2);
  });

  // Regresión: `unirse` chequeaba con count() y creaba después, sin atomicidad,
  // y 15 pedidos simultáneos de una IP esquivaban MAX_PENDIENTES_POR_IP.
  // Ahora count+create van en una transacción con advisory lock por ip_hash.
  it('unirse: 15 pedidos simultáneos de UNA misma IP no superan el tope de pendientes por IP', async () => {
    const db = new FakeDb();
    db.agregarSillas(2);
    const { servicio } = crear(db);

    await Promise.allSettled(
      Array.from({ length: 15 }, () => servicio.unirse('https://app.test', 'tok', '10.9.9.9')),
    );

    const { MAX_PENDIENTES_POR_IP } = await import('../common/throttle.config');
    expect(db.turnosEn('ESPERANDO_PAGO').length).toBeLessThanOrEqual(MAX_PENDIENTES_POR_IP);
  });
});
