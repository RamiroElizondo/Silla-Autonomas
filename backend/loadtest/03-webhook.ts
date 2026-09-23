/**
 * Escenario 3: carga sobre POST /webhooks/mercadopago, incluyendo
 * notificaciones DUPLICADAS a propósito (mismo `payment_id`/`data.id`
 * repetido) para ejercitar la idempotencia bajo carga.
 *
 * Firma HMAC: se reproduce EXACTAMENTE el mismo algoritmo que usa
 * `test/webhook-firma.e2e-spec.ts` (y `MercadoPagoService.validarFirma`):
 *
 *   manifest = "id:<data.id en minúscula>;request-id:<x-request-id>;ts:<ts>;"
 *   x-signature: `ts=<ts>,v1=<HMAC-SHA256(manifest, MP_WEBHOOK_SECRET) en hex>`
 *
 * Para que el servidor bajo prueba acepte estas firmas, tiene que tener
 * configurado el MISMO `MP_WEBHOOK_SECRET` que este script recibe por env
 * (no hace falta que sea el real de Mercado Pago — cualquier secreto sirve
 * mientras sea el mismo de los dos lados).
 *
 * Esquema de `data.id` (Bloque de loadtest, ver
 * src/mercadopago/mercadopago.service.ts → obtenerPago): con el servidor
 * corriendo con LOADTEST=true, el `data.id` que mandamos se interpreta como
 * el `paymentId` simulado, con el formato:
 *
 *   loadtest:<externalReference>:<monto>
 *
 * Si se pasa LOADTEST_EXTERNAL_REF (el external_reference de una Sesion
 * real en estado PAGO_PENDIENTE — conseguilo corriendo primero el
 * escenario 02, o a mano desde la tabla `sesiones`), todos los pagos
 * simulados apuntan a esa MISMA sesión: eso ejercita de verdad la
 * idempotencia contra la tabla `pagos` (activación única, no doble cobro).
 * Sin esa variable, se generan external_reference sintéticos que no
 * matchean ninguna sesión real — el webhook los procesa igual (firma
 * válida, 200 rápido) pero los ignora por "sesión no encontrada": sigue
 * siendo válido para medir throughput/latencia y el manejo de duplicados a
 * nivel HTTP, pero no ejercita el flujo completo de activación.
 *
 * Uso: node loadtest/03-webhook.js
 */
import { createHmac, randomUUID } from 'node:crypto';
import autocannon from 'autocannon';
import {
  AutocannonRequest,
  BASE_URL,
  chequearServidorArriba,
  envInt,
  envStr,
  imprimirEncabezado,
  imprimirResumen,
  requerirEnv,
} from './_util';

function firmar(secreto: string, params: { dataId: string; xRequestId: string; ts: string }): string {
  // Mismo algoritmo que MercadoPagoService.validarFirma / webhook-firma.e2e-spec.ts.
  const manifest =
    `id:${params.dataId.toLowerCase()};` +
    `request-id:${params.xRequestId};` +
    `ts:${params.ts};`;
  return createHmac('sha256', secreto).update(manifest).digest('hex');
}

function construirRequest(
  secreto: string,
  dataId: string,
  xRequestId: string,
): AutocannonRequest {
  const ts = String(Math.floor(Date.now() / 1000));
  const v1 = firmar(secreto, { dataId, xRequestId, ts });
  return {
    method: 'POST',
    path: `/webhooks/mercadopago?data.id=${encodeURIComponent(dataId)}&type=payment`,
    headers: {
      'content-type': 'application/json',
      'x-signature': `ts=${ts},v1=${v1}`,
      'x-request-id': xRequestId,
    },
    // El body no importa para la validación de firma (que usa la query
    // "data.id", no el body) ni para el parseo del webhook (que también lee
    // de la query primero) — se manda igual por prolijidad, imitando el
    // formato real de MP.
    body: JSON.stringify({ data: { id: dataId }, type: 'payment' }),
  };
}

async function main() {
  const secreto = requerirEnv(
    'MP_WEBHOOK_SECRET',
    'Tiene que ser EL MISMO valor configurado en el .env del servidor bajo prueba ' +
      '(cualquier string sirve, no hace falta el secreto real de Mercado Pago).',
  );
  const externalRefFijo = process.env.LOADTEST_EXTERNAL_REF; // opcional
  const monto = envInt('LOADTEST_MONTO', 3000);
  const cantidadUnicos = envInt('LOADTEST_PAGOS_UNICOS', 15);
  const conexiones = envInt('LOADTEST_CONNECTIONS', 30);
  const duracionSeg = envInt('LOADTEST_DURATION_SEC', 10);
  // Opcional: sin setear, autocannon manda a máxima velocidad posible, lo
  // que en la práctica choca casi de inmediato contra LIMITE_WEBHOOK (300
  // req/min por IP real, ver src/common/throttle.config.ts) porque todo el
  // tráfico de este script sale de una sola IP simulada (o de la real, sin
  // PROXY_SHARED_SECRET) — eso es ESPERADO y no es un bug: confirma que el
  // límite se sostiene sin 5xx incluso a miles de req/seg. Para ver en cambio
  // el ~100% de 2xx bajo duplicados (el foco original de este escenario),
  // seteá esto lo bastante bajo para quedar debajo de 300 requests totales
  // en la ventana de 60s (ej. LOADTEST_CONNECTION_RATE=1 con pocas conexiones).
  const connectionRateEnv = process.env.LOADTEST_CONNECTION_RATE;
  const connectionRate = connectionRateEnv ? Number(connectionRateEnv) : undefined;

  imprimirEncabezado({
    titulo: '03 — webhook de Mercado Pago (con duplicados a propósito)',
    descripcion:
      'Firma cada notificación con HMAC-SHA256 (mismo algoritmo que\n' +
      'MercadoPagoService.validarFirma) y arma un lote fijo de payment_ids\n' +
      `(${cantidadUnicos} distintos) que autocannon repite en ciclo durante toda\n` +
      'la duración del test: cada uno se manda muchas veces → duplicados\n' +
      'intencionales, para ejercitar la idempotencia bajo carga.',
    variables: [
      { nombre: 'LOADTEST_BASE_URL', valor: BASE_URL, obligatoria: false },
      { nombre: 'MP_WEBHOOK_SECRET', valor: '(no se imprime — es un secreto)', obligatoria: true },
      {
        nombre: 'LOADTEST_EXTERNAL_REF',
        valor:
          externalRefFijo ??
          '(no seteada: se generan external_reference sintéticos que no matchean ninguna sesión real)',
        obligatoria: false,
      },
      { nombre: 'LOADTEST_MONTO', valor: envStr('LOADTEST_MONTO', '3000'), obligatoria: false },
      {
        nombre: 'LOADTEST_PAGOS_UNICOS',
        valor: envStr('LOADTEST_PAGOS_UNICOS', '15'),
        obligatoria: false,
      },
      { nombre: 'LOADTEST_CONNECTIONS', valor: envStr('LOADTEST_CONNECTIONS', '30'), obligatoria: false },
      { nombre: 'LOADTEST_DURATION_SEC', valor: envStr('LOADTEST_DURATION_SEC', '10'), obligatoria: false },
      {
        nombre: 'LOADTEST_CONNECTION_RATE',
        valor:
          connectionRate !== undefined
            ? `${connectionRate} req/s por conexión`
            : '(no seteada: autocannon manda a máxima velocidad → va a pisar LIMITE_WEBHOOK, 300/min por IP, casi de inmediato — esperable, no es un bug)',
        obligatoria: false,
      },
    ],
  });

  await chequearServidorArriba();

  const requests: AutocannonRequest[] = [];
  for (let i = 0; i < cantidadUnicos; i++) {
    const externalReference = externalRefFijo ?? `loadtest-${randomUUID()}|loadtest-silla`;
    const dataId = `loadtest:${externalReference}:${monto}`;
    const xRequestId = `loadtest-req-${i}-${randomUUID()}`;
    requests.push(construirRequest(secreto, dataId, xRequestId));
  }

  console.log(
    `Lote armado: ${requests.length} notificaciones distintas, firmadas, que ` +
      'autocannon va a repetir en ciclo durante todo el test (eso produce los ' +
      'duplicados intencionales).\n',
  );

  const opcionesAutocannon: any = {
    url: BASE_URL,
    connections: conexiones,
    duration: duracionSeg,
    requests,
  };
  if (connectionRate !== undefined) {
    opcionesAutocannon.connectionRate = connectionRate;
  }

  const resultado = await autocannon(opcionesAutocannon);

  imprimirResumen('03 — webhook Mercado Pago', resultado as any);

  const status: any = resultado;
  const status4xx = status['4xx'] ?? 0;
  console.log(
    connectionRate !== undefined
      ? `Nota: con LOADTEST_CONNECTION_RATE seteado, se espera 2xx en (casi) el 100% de\n` +
        `las respuestas — la firma se valida ANTES de tocar la base, así que un webhook\n` +
        `bien firmado siempre responde 200 rápido. 4xx observados=${status4xx} (si es > 0,\n` +
        'revisar que MP_WEBHOOK_SECRET sea idéntico al del servidor, o que el total de\n' +
        'requests no haya superado igual las 300/min de LIMITE_WEBHOOK).'
      : `Nota: SIN LOADTEST_CONNECTION_RATE, autocannon manda a máxima velocidad y va a\n` +
        `agotar LIMITE_WEBHOOK (300 req/min por IP) casi de inmediato — vas a ver sobre todo\n` +
        `429, no 403. Eso es ESPERADO, no un bug: confirma que el límite se sostiene sin\n` +
        `5xx incluso a miles de req/seg desde una sola IP. 4xx observados=${status4xx}.\n` +
        'Para ver en cambio el ~100% de 2xx bajo duplicados, volvé a correr con\n' +
        'LOADTEST_CONNECTION_RATE bajo (ver encabezado de este mismo escenario).',
  );
  if ((status['5xx'] ?? 0) > 0) {
    console.warn(
      `ATENCIÓN: hubo ${status['5xx']} respuestas 5xx. El controller responde 200 ` +
        'siempre que la firma sea válida (el procesamiento real es fire-and-forget) ' +
        '— revisar logs del servidor.',
    );
  }
}

main().catch((e) => {
  console.error('Error corriendo el escenario 03:', e);
  process.exit(1);
});
