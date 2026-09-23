/**
 * Escenario 1: ráfagas de polling concurrente sobre los endpoints públicos
 * de "estado" que cachea `TtlCache` (TTL de 1.5s, ver src/common/cache.config.ts):
 *
 *   GET /sillas/:id/estado
 *   GET /cola/estado
 *   GET /cola/:id/estado   (solo si se pasa LOADTEST_TURNO_ID)
 *
 * Objetivo: demostrar que el caché absorbe el sondeo simultáneo de varios
 * celulares + la pantalla TV del local sin generar una consulta a Postgres
 * por cada request. Concurrencia ALTA, duración CORTA.
 *
 * Este escenario NO necesita LOADTEST=true en el servidor (son lecturas
 * públicas, no tocan Mercado Pago ni Shelly) — pero no molesta si está.
 *
 * Uso: node loadtest/01-estado-publico.js  (o `ts-node loadtest/01-estado-publico.ts`)
 */
import autocannon from 'autocannon';
import {
  AutocannonRequest,
  BASE_URL,
  chequearServidorArriba,
  construirSimuladorMultiIp,
  envInt,
  envStr,
  imprimirEncabezado,
  imprimirResumen,
  requerirEnv,
} from './_util';

async function main() {
  const sillaId = requerirEnv(
    'LOADTEST_SILLA_ID',
    'UUID de una Silla sembrada en la base (ver "npm run seed" o la tabla `sillas`).',
  );
  const turnoId = process.env.LOADTEST_TURNO_ID; // opcional
  const conexiones = envInt('LOADTEST_CONNECTIONS', 80);
  const duracionSeg = envInt('LOADTEST_DURATION_SEC', 12);
  const connectionRate = envInt('LOADTEST_CONNECTION_RATE', 2);
  const multiIp = construirSimuladorMultiIp();

  imprimirEncabezado({
    titulo: '01 — estado público (cache TtlCache, 1.5s TTL)',
    descripcion:
      'Simula el sondeo concurrente de varios celulares y la pantalla TV\n' +
      'pidiendo el estado de la silla y de la cola al mismo tiempo. Con el\n' +
      'caché funcionando, la tasa de requests/seg puede ser mucho más alta\n' +
      'que la de queries reales a Postgres sin que el servidor se caiga.',
    variables: [
      { nombre: 'LOADTEST_BASE_URL', valor: BASE_URL, obligatoria: false },
      { nombre: 'LOADTEST_SILLA_ID', valor: sillaId, obligatoria: true },
      {
        nombre: 'LOADTEST_TURNO_ID',
        valor: turnoId ?? '(no seteada: se omite GET /cola/:id/estado)',
        obligatoria: false,
      },
      { nombre: 'LOADTEST_CONNECTIONS', valor: envStr('LOADTEST_CONNECTIONS', '80'), obligatoria: false },
      { nombre: 'LOADTEST_DURATION_SEC', valor: envStr('LOADTEST_DURATION_SEC', '12'), obligatoria: false },
      { nombre: 'LOADTEST_CONNECTION_RATE', valor: `${connectionRate} req/s por conexión`, obligatoria: false },
      {
        nombre: 'PROXY_SHARED_SECRET',
        valor: multiIp.activo
          ? 'seteada: simulando 1 IP distinta por conexión (tráfico realista de muchos clientes)'
          : 'NO seteada: TODO el tráfico comparte tu IP real → el rate limit por IP (240/min, ' +
            'Hallazgo ALTO 1) va a dominar el resultado casi de inmediato, sin decir nada del ' +
            'caché. Seteala igual en el servidor y acá (mismo valor) para un resultado real.',
        obligatoria: false,
      },
    ],
  });

  await chequearServidorArriba();

  // Se pesa más el estado de la silla puntual (3x) que el resumen de cola
  // (1x): es el patrón real — cada celular sondea SU silla, mientras que
  // /cola/estado lo pide una sola pantalla TV por local.
  const requests: AutocannonRequest[] = [
    { method: 'GET', path: `/sillas/${sillaId}/estado` },
    { method: 'GET', path: `/sillas/${sillaId}/estado` },
    { method: 'GET', path: `/sillas/${sillaId}/estado` },
    { method: 'GET', path: '/cola/estado' },
  ];
  if (turnoId) {
    requests.push({ method: 'GET', path: `/cola/${turnoId}/estado` });
  }

  // IMPORTANTE sobre cómo se aplica la IP simulada (autocannon 8.0.0):
  // `client.setHeaders()` (la API "pública" documentada) solo pisa los
  // headers de la request que esté "actual" en ESE momento — con varias
  // requests distintas en el array (como acá: 3x /sillas/:id/estado + 1x
  // /cola/estado) eso deja a la mayoría sin el header seteado. La forma que
  // sí cubre TODAS las requests, todo el tiempo, es `setupRequest(req,
  // context)` en cada request del array — se llama de nuevo en cada ciclo
  // por ese request — leyendo un `context` que sembramos por conexión en
  // `setupClient` de abajo. `context` normalmente se resetea a
  // `initialContext` al completar una vuelta entera al array de requests;
  // por eso sembramos `initialContext` (no solo `context`) para que sobreviva
  // todos los resets durante toda la corrida. Esto usa un campo interno de
  // autocannon (`client.requestIterator`) no documentado en su README, pero
  // confirmado leyendo el código fuente de la versión instalada
  // (`node_modules/autocannon@8.0.0`) — si se actualiza el paquete a otra
  // versión mayor, revisar que esto siga funcionando.
  if (multiIp.activo) {
    for (const req of requests) {
      (req as any).setupRequest = (r: any, context: any) => {
        r.headers = context.headersMultiIp ?? {};
        return r;
      };
    }
  }

  const opcionesAutocannon: any = {
    url: BASE_URL,
    connections: conexiones,
    duration: duracionSeg,
    connectionRate,
    requests,
  };
  if (multiIp.activo) {
    opcionesAutocannon.setupClient = (client: any) => {
      const contexto = { headersMultiIp: multiIp.headersPorConexion() };
      client.requestIterator.initialContext = contexto;
      client.requestIterator.context = contexto;
    };
  }

  const resultado = await autocannon(opcionesAutocannon);

  imprimirResumen('01 — estado público', resultado as any);

  const status: any = resultado;
  if ((status['5xx'] ?? 0) > 0) {
    console.warn(
      `ATENCIÓN: hubo ${status['5xx']} respuestas 5xx. El caché no debería dejar pasar ` +
        'esto bajo carga de solo lectura — revisar logs del servidor.',
    );
  }
}

main().catch((e) => {
  console.error('Error corriendo el escenario 01:', e);
  process.exit(1);
});
