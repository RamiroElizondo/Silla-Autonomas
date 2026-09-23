/**
 * Escenario 2: múltiples clientes iniciando pago al mismo tiempo.
 *
 *   POST /sillas/:id/checkout
 *   POST /cola/checkout          (opcional, con LOADTEST_INCLUIR_COLA=true)
 *
 * REQUISITOS DEL SERVIDOR BAJO PRUEBA (ver README.md):
 *   - LOADTEST=true                — si no, este escenario le pega miles de
 *     veces al SDK REAL de Mercado Pago (plata/sandbox real). NO CORRER
 *     esto contra un backend sin LOADTEST=true.
 *   - TURNSTILE_SECRET_KEY sin configurar (o una site/secret key de prueba
 *     de Cloudflare que siempre pase) — con la key real de producción
 *     configurada, el checkout va a rechazar todo con 403 porque este
 *     script no manda un `turnstileToken` de verdad (ver
 *     src/common/turnstile.service.ts: sin `TURNSTILE_SECRET_KEY`, la
 *     verificación queda deshabilitada y siempre pasa — no hace falta
 *     ningún cambio de código para el load test, solo no configurar esa
 *     variable en el entorno de prueba).
 *
 * OJO — Hallazgo ALTO 2 / MAX_PENDIENTES_POR_IP: autocannon manda todas las
 * requests desde la MISMA conexión/IP simulada (localhost). El backend
 * limita cuántas reservas PAGO_PENDIENTE tolera por IP (default 3, ver
 * MAX_PENDIENTES_POR_IP en .env.example) antes de responder 429. Así que
 * es ESPERADO (no un bug) ver la gran mayoría de las respuestas en 429
 * apenas arranca el escenario. Lo que este escenario confirma es que ese
 * 429 se sostiene ESTABLE bajo carga (nunca 500, nunca cuelga el proceso),
 * no que todos los checkouts se acepten — eso requeriría simular IPs
 * distintas de verdad, fuera del alcance de este script.
 *
 * Uso: node loadtest/02-checkout.js
 */
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

async function main() {
  const sillaId = requerirEnv(
    'LOADTEST_SILLA_ID',
    'UUID de una Silla sembrada en la base (ver "npm run seed" o la tabla `sillas`).',
  );
  const incluirCola = process.env.LOADTEST_INCLUIR_COLA === 'true';
  const conexiones = envInt('LOADTEST_CONNECTIONS', 15);
  const duracionSeg = envInt('LOADTEST_DURATION_SEC', 10);

  imprimirEncabezado({
    titulo: '02 — checkout (POST /sillas/:id/checkout)',
    descripcion:
      'Simula varios clientes tocando "Pagar" casi en simultáneo.\n' +
      'Requiere LOADTEST=true en el servidor (ver comentario arriba en\n' +
      'este archivo) y TURNSTILE_SECRET_KEY sin configurar en el entorno\n' +
      'de prueba. Se espera una mayoría de 429 por MAX_PENDIENTES_POR_IP\n' +
      '(todas las requests salen de la misma IP simulada) — es lo esperado.',
    variables: [
      { nombre: 'LOADTEST_BASE_URL', valor: BASE_URL, obligatoria: false },
      { nombre: 'LOADTEST_SILLA_ID', valor: sillaId, obligatoria: true },
      {
        nombre: 'LOADTEST_INCLUIR_COLA',
        valor: String(incluirCola),
        obligatoria: false,
      },
      {
        nombre: 'LOADTEST_CONNECTIONS',
        valor: envStr('LOADTEST_CONNECTIONS', '15'),
        obligatoria: false,
      },
      {
        nombre: 'LOADTEST_DURATION_SEC',
        valor: envStr('LOADTEST_DURATION_SEC', '10'),
        obligatoria: false,
      },
    ],
  });

  await chequearServidorArriba();

  const cuerpoVacio = JSON.stringify({});
  const headersJson = { 'content-type': 'application/json' };

  const requests: AutocannonRequest[] = [
    { method: 'POST', path: `/sillas/${sillaId}/checkout`, headers: headersJson, body: cuerpoVacio },
  ];
  if (incluirCola) {
    requests.push({ method: 'POST', path: '/cola/checkout', headers: headersJson, body: cuerpoVacio });
  }

  const resultado = await autocannon({
    url: BASE_URL,
    connections: conexiones,
    duration: duracionSeg,
    requests,
  });

  imprimirResumen('02 — checkout', resultado as any);

  const status: any = resultado;
  const con429 = status['4xx'] ?? 0;
  const con5xx = status['5xx'] ?? 0;
  console.log(
    `Nota: de las respuestas no-2xx, se esperan sobre todo 429 (tope de ` +
      `reservas pendientes por IP). 4xx totales=${con429}.`,
  );
  if (con5xx > 0) {
    console.warn(
      `ATENCIÓN: hubo ${con5xx} respuestas 5xx. El checkout debería fallar con 429 ` +
        '(rate limit) o 403 (Turnstile), nunca con un error de servidor — revisar logs.',
    );
  }
}

main().catch((e) => {
  console.error('Error corriendo el escenario 02:', e);
  process.exit(1);
});
