/**
 * Test de integración con Postgres REAL: condición de carrera entre el
 * Webhook de Mercado Pago y el retorno del navegador.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * QUÉ PRUEBA
 * ─────────────────────────────────────────────────────────────────────────
 * Cuando un cliente paga, dos caminos pueden llegar a
 * `PagosService.procesarNotificacionPago(paymentId, ...)` casi al mismo
 * tiempo para el MISMO `payment_id`:
 *
 *   1. El Webhook de Mercado Pago (`POST /webhooks/mercadopago`).
 *   2. El retorno del navegador a `/silla/:id/exito`, que llama a
 *      `confirmarRetornoSilla` como respaldo si el Webhook todavía no llegó
 *      — y que internamente también termina en `procesarPagoVerificado`.
 *
 * Ambos caminos, si corren en paralelo, intentan registrar el mismo pago y
 * activar la misma sesión. La protección real contra activarla dos veces
 * (o registrarla dos veces) vive en `PagosService.registrarEstadoPago`: un
 * `prisma.pago.create` con constraint único en `Pago.paymentIdMp` (ver
 * `@unique` en `prisma/schema.prisma`) — el segundo insert concurrente choca
 * con el motor de la base y Postgres le devuelve el error `P2002`, que el
 * código atrapa y traduce en "no me toca aplicar este pago".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUÉ NECESITA POSTGRES REAL (no se puede mockear)
 * ─────────────────────────────────────────────────────────────────────────
 * Un mock de Prisma en JavaScript/Jest NUNCA puede reproducir esta condición
 * de carrera de verdad: el event loop de Node es de un solo hilo, así que
 * dos `await servicio.procesarNotificacionPago(...)` "concurrentes" en un
 * test con mocks en realidad se ejecutan de forma serializada apenas una
 * promesa cede el control — nunca chocan a nivel de motor de base de datos
 * porque no hay motor de base de datos. El constraint único y el error
 * P2002 solo existen cuando hay un Postgres real resolviendo dos inserts
 * que efectivamente compiten por la misma fila. Por eso este archivo vive
 * separado de los `*.spec.ts` (que sí corren con Prisma mockeado en
 * `src/pagos/pagos.service.spec.ts`) y usa su propio runner (`test:int`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ESTE TEST NO CORRE EN EL SANDBOX DE DESARROLLO DE CLAUDE
 * ─────────────────────────────────────────────────────────────────────────
 * El entorno donde se escribió este archivo no tiene un Postgres real
 * disponible, así que este test nunca se ejecutó con éxito ahí — solo se
 * confirmó que compila limpio con `tsc --noEmit` contra el cliente de
 * Prisma real. Para correrlo hace falta una base de PRUEBA real (nunca la
 * de desarrollo/producción) con las migraciones aplicadas:
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/silla_test \
 *     npx prisma migrate deploy --schema=./prisma/schema.prisma
 *
 *   (con DATABASE_URL=$TEST_DATABASE_URL en el entorno de ESE comando
 *   puntual, para que `prisma migrate deploy` — que solo lee DATABASE_URL —
 *   apunte a la base de test y no a la de desarrollo)
 *
 * y después:
 *
 *   npm run test:int
 *
 * Nunca se usa `DATABASE_URL` a secas como fallback dentro del test: sería
 * peligroso correrlo por error contra una base de desarrollo o producción
 * real. Si `TEST_DATABASE_URL` no está seteada, el test falla de entrada
 * con un mensaje explícito (ver `beforeAll` más abajo).
 */

import { EstadoSesion, PrismaClient } from '@prisma/client';
import { PagosService } from '../../src/pagos/pagos.service';
import { SesionesService } from '../../src/sesiones/sesiones.service';

// Formato de MAC válido para Shelly (aabbccddeeff), pero no corresponde a
// ningún dispositivo real: nunca se llega a llamar a la Shelly Cloud API de
// verdad porque `shelly.setRele` está mockeado en este test (ver más abajo
// — lo único bajo prueba acá es la carrera en Postgres, no el hardware).
const DEVICE_ID_FICTICIO = 'aabbccddeeff';
const MONTO_SESION = 1500;
const PAYMENT_ID_RACE = 'pay-race-1';

describe('PagosService — condición de carrera Webhook vs. retorno del navegador (Postgres real)', () => {
  let prisma: PrismaClient;
  let sesionesService: SesionesService;
  let pagosService: PagosService;
  let sillaId: string | undefined;
  let sesionId: string | undefined;
  let externalReference: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      // A propósito NO cae a `process.env.DATABASE_URL`: correr esto sin
      // querer contra la base de desarrollo o producción borraría/alteraría
      // datos reales (el test crea y borra Silla/Sesion/Pago).
      throw new Error(
        'TEST_DATABASE_URL no está configurada. Este test de integración necesita una base ' +
          'Postgres de PRUEBA real (nunca la de desarrollo o producción) con las migraciones ' +
          'ya aplicadas. Corré:\n\n' +
          '  TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/silla_test \\\n' +
          '    npx prisma migrate deploy --schema=./prisma/schema.prisma\n\n' +
          '(con DATABASE_URL=$TEST_DATABASE_URL en el entorno de ese comando puntual) y después ' +
          '`npm run test:int`. Ver el comentario al tope de este archivo.',
      );
    }

    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();

    // Dependencias de SesionesService que NO son parte de la condición de
    // carrera bajo prueba: mocks triviales. `shelly.setRele` se mockea para
    // que `activarSesion` no intente contactar la Shelly Cloud API real.
    const shelly: any = { setRele: jest.fn().mockResolvedValue(undefined) };
    const heartbeat: any = {};
    const creditosDeSesiones: any = {};
    const sillasDeSesiones: any = { invalidarCache: jest.fn() };

    // SesionesService REAL (no mockeado) con el mismo PrismaClient real:
    // es clave que sea real para que el `updateMany` con guarda de estado
    // que hace `activarSesion` también se ejerza contra la base real, no
    // contra un mock que no puede correr en paralelo de verdad.
    sesionesService = new SesionesService(
      prisma,
      shelly,
      heartbeat,
      creditosDeSesiones,
      sillasDeSesiones,
    );

    // mp.obtenerPago: siempre devuelve el mismo pago aprobado, sin importar
    // cuántas veces se llame — simula que tanto el Webhook como el retorno
    // del navegador consultan la misma API de Mercado Pago y reciben el
    // mismo resultado.
    const mp: any = {
      obtenerPago: jest.fn().mockResolvedValue({
        id: 999,
        status: 'approved',
        transaction_amount: MONTO_SESION,
        currency_id: 'ARS',
        external_reference: '', // se completa en el `beforeAll` de más abajo
      }),
    };

    // El resto de las dependencias de PagosService no se usan en el método
    // bajo prueba (`procesarNotificacionPago`): mocks triviales.
    const sillasDePagos: any = {};
    const cola: any = {};
    const turnstile: any = {};
    const ipHash: any = {};
    const creditosDePagos: any = {};
    const config: any = { get: () => '' };

    pagosService = new PagosService(
      prisma,
      mp,
      sesionesService,
      sillasDePagos,
      cola,
      turnstile,
      ipHash,
      creditosDePagos,
      config,
    );

    const silla = await prisma.silla.create({
      data: {
        nombre: 'Silla de prueba (pagos-race.int-spec)',
        precio: MONTO_SESION,
        duracionMin: 10,
        deviceIdShelly: DEVICE_ID_FICTICIO,
      },
    });
    sillaId = silla.id;

    externalReference = `int-test-race-${silla.id}`;
    mp.obtenerPago.mockResolvedValue({
      id: 999,
      status: 'approved',
      transaction_amount: MONTO_SESION,
      currency_id: 'ARS',
      external_reference: externalReference,
    });

    const sesion = await prisma.sesion.create({
      data: {
        sillaId,
        estado: EstadoSesion.PENDIENTE,
        externalReference,
        monto: MONTO_SESION,
        duracionMin: 10,
      },
    });
    sesionId = sesion.id;
  });

  afterAll(async () => {
    if (!prisma) return;

    // Nunca dejar corriendo el timer real de auto-finalización que
    // `activarSesion` programa con `setTimeout` (ver
    // `SesionesService.programar`): si no se limpia, el proceso de Jest
    // queda vivo esperando ese timer varios minutos.
    const timers: Map<string, NodeJS.Timeout> | undefined = (sesionesService as any)?.timers;
    timers?.forEach((t) => clearTimeout(t));

    // Filtrado siempre por el id de la Silla de prueba: si por error esto
    // corriera contra una base compartida, no toca nada que no haya creado
    // este test.
    if (sillaId) {
      await prisma.pago.deleteMany({ where: { sesion: { sillaId } } });
      await prisma.sesion.deleteMany({ where: { sillaId } });
      await prisma.silla.deleteMany({ where: { id: sillaId } });
    }
    await prisma.$disconnect();
  });

  it(
    'el Webhook y el retorno del navegador llegando casi juntos (mismo payment_id) ' +
      'activan la sesión una sola vez, sin duplicar el registro del pago',
    async () => {
      // Simula el Webhook y el retorno del navegador llegando casi al mismo
      // tiempo: mismo `paymentId` a propósito, disparados en paralelo.
      const resultados = await Promise.allSettled([
        pagosService.procesarNotificacionPago(PAYMENT_ID_RACE, { origen: 'webhook' }),
        pagosService.procesarNotificacionPago(PAYMENT_ID_RACE, { origen: 'retorno_navegador' }),
      ]);

      // Ninguno de los dos caminos debe terminar en una excepción sin
      // manejar: el que pierde la carrera del `create` simplemente no debe
      // aplicar el pago, no reventar.
      for (const r of resultados) {
        expect(r.status).toBe('fulfilled');
      }

      // 1) Exactamente UN registro de Pago para este payment_id — nunca dos,
      // pase lo que pase con el orden real de llegada de las dos llamadas.
      const pagos = await prisma.pago.findMany({
        where: { paymentIdMp: PAYMENT_ID_RACE },
      });
      expect(pagos).toHaveLength(1);
      expect(pagos[0].estado).toBe('APROBADO');
      expect(pagos[0].sesionId).toBe(sesionId);

      // 2) La sesión se activó una sola vez, de forma consistente: quedó
      // ACTIVA (no se rompió a mitad de camino) con su timer programado.
      const sesionFinal = await prisma.sesion.findUniqueOrThrow({
        where: { id: sesionId! },
      });
      expect(sesionFinal.estado).toBe('ACTIVA');
      expect(sesionFinal.inicio).not.toBeNull();
      expect(sesionFinal.finProgramado).not.toBeNull();
    },
  );
});
