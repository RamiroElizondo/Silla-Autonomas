/**
 * Utilidades compartidas por los 4 escenarios de `backend/loadtest/`.
 *
 * IMPORTANTE (ver README.md de esta carpeta): estos scripts están pensados
 * para correr contra un backend real (Postgres real, migraciones aplicadas)
 * con `LOADTEST=true`, NUNCA contra producción. Este archivo no hace nada
 * peligroso por sí solo — es solo lectura de env vars, un chequeo de salud
 * por HTTP y un formateador de resultados de `autocannon` — pero lo repiten
 * los 4 scripts, así que vive acá una sola vez.
 */

/** URL base del backend bajo prueba. Configurable, nunca hardcodeada. */
export const BASE_URL = (process.env.LOADTEST_BASE_URL ?? 'http://localhost:3001').replace(
  /\/+$/,
  '',
);

/** Endpoint público y sin auth que se usa solo para confirmar que el server responde. */
const ENDPOINT_SALUD = `${BASE_URL}/cola/estado`;

export function envStr(nombre: string, porDefecto: string): string {
  const v = process.env[nombre];
  return v && v.trim() !== '' ? v : porDefecto;
}

export function envInt(nombre: string, porDefecto: number): number {
  const v = process.env[nombre];
  if (!v) return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

/** Corta la ejecución con un mensaje claro si falta una variable obligatoria. */
export function requerirEnv(nombre: string, explicacion: string): string {
  const v = process.env[nombre];
  if (!v || v.trim() === '') {
    console.error(`\nERROR: falta la variable de entorno ${nombre}.`);
    console.error(explicacion);
    console.error('Ver backend/loadtest/README.md.\n');
    process.exit(1);
  }
  return v;
}

/**
 * Falla temprano y con un mensaje claro si el backend no está arriba en
 * `LOADTEST_BASE_URL`, en vez de dejar que autocannon reporte cientos de
 * ECONNREFUSED sin contexto.
 */
export async function chequearServidorArriba(): Promise<void> {
  try {
    const res = await fetch(ENDPOINT_SALUD);
    // Cualquier respuesta HTTP (200, 404, lo que sea) confirma que hay un
    // servidor HTTP real escuchando — no nos importa el body acá.
    void res.status;
  } catch (e) {
    console.error(`\nERROR: no se pudo conectar a ${BASE_URL} (probado en ${ENDPOINT_SALUD}).`);
    console.error(
      '¿Está corriendo el backend (npm run start:dev / npm run start) en esa URL?\n' +
        'Ver backend/loadtest/README.md para el procedimiento completo antes de correr esto.',
    );
    console.error(`Detalle: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

/** Imprime lo que este escenario necesita, antes de arrancar. */
export function imprimirEncabezado(params: {
  titulo: string;
  descripcion: string;
  variables: Array<{ nombre: string; valor: string; obligatoria: boolean }>;
}): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Escenario de carga: ${params.titulo}`);
  console.log('='.repeat(70));
  console.log(params.descripcion);
  console.log(`\nURL base:        ${BASE_URL}`);
  console.log('\nVariables de entorno:');
  for (const v of params.variables) {
    const marca = v.obligatoria ? '(obligatoria)' : '(default aplicado)';
    console.log(`  ${v.nombre.padEnd(28)} = ${v.valor}  ${marca}`);
  }
  console.log('');
}

/**
 * Forma mínima de un request programático de `autocannon` que usamos en los
 * 4 escenarios. `autocannon` no trae sus propios tipos (no es un problema:
 * ver README de esta carpeta), así que declaramos acá lo poco que
 * necesitamos en vez de tipar todo el paquete.
 */
export interface AutocannonRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Forma mínima del resultado de `autocannon` que usamos para el resumen. */
export interface ResultadoAutocannon {
  duration: number;
  connections: number;
  requests: { average: number; mean: number; total: number; sent: number };
  latency: { average: number; p50: number; p90: number; p99: number; max: number };
  throughput: { average: number };
  errors: number;
  timeouts: number;
  non2xx: number;
  '1xx'?: number;
  '2xx'?: number;
  '3xx'?: number;
  '4xx'?: number;
  '5xx'?: number;
  resets?: number;
}

/**
 * Simula múltiples clientes reales distintos en vez de que TODO el tráfico
 * de autocannon salga de una sola IP (localhost). Sin esto, el rate limit
 * por IP (Hallazgo ALTO 1 — ver src/common/throttle.config.ts, 240 req/min
 * para los endpoints de estado) devuelve 429 casi de inmediato apenas hay
 * más de un puñado de conexiones concurrentes, sin decir nada sobre el
 * caché — el límite está pensado para UN cliente real, no para que un load
 * test simule cientos desde la misma IP.
 *
 * Reusa el mismo mecanismo que el proxy real del frontend usaría
 * (`resolverIpConfiable` en el backend): los headers `x-client-ip` +
 * `x-proxy-secret` solo se confían si el secreto coincide con
 * `PROXY_SHARED_SECRET` configurado en el servidor bajo prueba. Sin esa
 * variable seteada en ESTA terminal (la del load test), este helper queda
 * inactivo y el comportamiento es el de antes (una sola IP real).
 *
 * Las IPs simuladas son del rango TEST-NET-3 (203.0.113.0/24, RFC 5737):
 * reservado para documentación/testing, nunca una IP real de internet.
 */
export function construirSimuladorMultiIp(): {
  activo: boolean;
  headersPorConexion: () => Record<string, string>;
} {
  const secreto = process.env.PROXY_SHARED_SECRET;
  if (!secreto) {
    return { activo: false, headersPorConexion: () => ({}) };
  }
  let contador = 0;
  return {
    activo: true,
    headersPorConexion: () => {
      const n = contador++;
      const ip = `203.0.113.${1 + (n % 254)}`;
      return { 'x-client-ip': ip, 'x-proxy-secret': secreto };
    },
  };
}

/** Imprime un resumen legible del resultado de autocannon (no el JSON crudo). */
export function imprimirResumen(titulo: string, r: ResultadoAutocannon): void {
  console.log(`\n${'-'.repeat(70)}`);
  console.log(`Resultado: ${titulo}`);
  console.log('-'.repeat(70));
  console.log(`Duración:          ${r.duration}s`);
  console.log(`Conexiones:        ${r.connections}`);
  console.log(`Requests enviados: ${r.requests.sent ?? r.requests.total}`);
  console.log(
    `Requests/seg:      promedio=${r.requests.average}  (mean=${r.requests.mean})`,
  );
  console.log(`Throughput:        promedio=${(r.throughput.average / 1024).toFixed(1)} KB/s`);
  console.log(
    `Latencia (ms):     p50=${r.latency.p50}  p90=${r.latency.p90}  p99=${r.latency.p99}  max=${r.latency.max}`,
  );
  console.log(
    `Códigos HTTP:      2xx=${r['2xx'] ?? 0}  3xx=${r['3xx'] ?? 0}  4xx=${r['4xx'] ?? 0}  ` +
      `5xx=${r['5xx'] ?? 0}  non2xx=${r.non2xx}`,
  );
  console.log(`Errores de socket: ${r.errors}   Timeouts: ${r.timeouts}`);
  console.log('-'.repeat(70) + '\n');
}
