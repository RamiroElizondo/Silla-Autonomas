/**
 * Escenario 4: carga sobre endpoints admin autenticados, para confirmar que
 * el rate limit de esos endpoints no bloquea el uso normal del panel bajo
 * carga moderada concurrente (varias pestañas/dueños mirando el panel a la
 * vez, polling de métricas, etc).
 *
 *   POST /admin/auth/login   (una sola vez, antes de arrancar autocannon)
 *   GET  /admin/sesiones
 *   GET  /admin/pagos/revision
 *   GET  /admin/metricas
 *
 * Requiere un usuario admin real ya sembrado (ver "npm run seed", que crea
 * el usuario con ADMIN_EMAIL/ADMIN_PASSWORD del .env del servidor). Este
 * script usa esas MISMAS variables de entorno para loguearse.
 *
 * Uso: node loadtest/04-admin-panel.js
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

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    console.error(`\nERROR: login admin falló con HTTP ${res.status}: ${texto}`);
    console.error(
      'Revisá ADMIN_EMAIL/ADMIN_PASSWORD (tienen que ser los del usuario admin ' +
        'sembrado en la base con "npm run seed") y que el servidor no esté ' +
        'bloqueado por LoginBloqueoService (demasiados intentos fallidos previos).',
    );
    process.exit(1);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    console.error('\nERROR: /admin/auth/login respondió 200 pero sin `token`.');
    process.exit(1);
  }
  return data.token;
}

async function main() {
  const email = requerirEnv('ADMIN_EMAIL', 'El email del usuario admin sembrado con "npm run seed".');
  const password = requerirEnv(
    'ADMIN_PASSWORD',
    'La contraseña del usuario admin sembrado con "npm run seed".',
  );
  const conexiones = envInt('LOADTEST_CONNECTIONS', 15);
  const duracionSeg = envInt('LOADTEST_DURATION_SEC', 10);
  // Igual que en 01 y 03: sin esto, autocannon manda a máxima velocidad desde
  // una sola IP real, lo que en la práctica excede LIMITE_GLOBAL (240 req/min
  // por IP, ver throttle.config.ts — estos endpoints no tienen @Throttle propio)
  // casi de inmediato. Eso ya no representa 'varias pestañas del dueño
  // sondeando métricas' (el escenario real que esto quiere probar) sino un
  // flood de una sola IP. Seteala para simular ese uso normal (ej. 2-3 req/s
  // por conexión); sin setear, igual sirve para confirmar que el límite
  // aguanta sin 5xx bajo una ráfaga desmedida.
  const connectionRateEnv = process.env.LOADTEST_CONNECTION_RATE;
  const connectionRate = connectionRateEnv ? Number(connectionRateEnv) : undefined;

  imprimirEncabezado({
    titulo: '04 — panel admin (endpoints autenticados)',
    descripcion:
      'Se loguea una vez contra /admin/auth/login y reusa el mismo JWT en\n' +
      'todas las requests de carga (como un dueño con el panel abierto en\n' +
      'varias pestañas, no como varios logins simultáneos).',
    variables: [
      { nombre: 'LOADTEST_BASE_URL', valor: BASE_URL, obligatoria: false },
      { nombre: 'ADMIN_EMAIL', valor: email, obligatoria: true },
      { nombre: 'ADMIN_PASSWORD', valor: '(no se imprime)', obligatoria: true },
      { nombre: 'LOADTEST_CONNECTIONS', valor: envStr('LOADTEST_CONNECTIONS', '15'), obligatoria: false },
      { nombre: 'LOADTEST_DURATION_SEC', valor: envStr('LOADTEST_DURATION_SEC', '10'), obligatoria: false },
      {
        nombre: 'LOADTEST_CONNECTION_RATE',
        valor:
          connectionRate !== undefined
            ? `${connectionRate} req/s por conexión`
            : '(no seteada: autocannon manda a máxima velocidad → va a pisar LIMITE_GLOBAL, 240/min por IP, casi de inmediato — esperable, no es un bug)',
        obligatoria: false,
      },
    ],
  });

  await chequearServidorArriba();

  console.log('Iniciando sesión como admin...');
  const token = await login(email, password);
  console.log('Login OK, arrancando la carga.\n');

  const headersAuth = { authorization: `Bearer ${token}` };
  const requests: AutocannonRequest[] = [
    { method: 'GET', path: '/admin/sesiones?take=50', headers: headersAuth },
    { method: 'GET', path: '/admin/pagos/revision', headers: headersAuth },
    { method: 'GET', path: '/admin/metricas', headers: headersAuth },
  ];

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

  imprimirResumen('04 — panel admin', resultado as any);

  const status: any = resultado;
  const con4xx = status['4xx'] ?? 0;
  const con5xx = status['5xx'] ?? 0;
  if (con5xx > 0) {
    console.warn(
      `ATENCIÓN: hubo ${con5xx} respuestas 5xx. El panel admin no debería fallar ` +
        'con un error de servidor bajo esta carga — revisar logs. Si en cambio ' +
        'ves 401, puede ser que el JWT haya expirado a mitad del test (ver ' +
        'JWT_EXPIRES_IN) o que se haya hecho logout desde otro lado (tokenVersion).',
    );
  } else if (con4xx > 0) {
    console.log(
      connectionRate !== undefined
        ? `Nota: hubo ${con4xx} respuestas 4xx pese a LOADTEST_CONNECTION_RATE — revisar ` +
          'si igual se superaron las 240 req/min de LIMITE_GLOBAL, o si el JWT expiró ' +
          '(JWT_EXPIRES_IN) a mitad del test.'
        : `Nota: ${con4xx} respuestas 4xx — esperable sin LOADTEST_CONNECTION_RATE, ya ` +
          'que autocannon manda a máxima velocidad desde una sola IP y excede ' +
          'LIMITE_GLOBAL (240/min) casi de inmediato. No es un bug: confirma que el ' +
          'límite se sostiene sin 5xx. Para ver el uso normal (varias pestañas ' +
          'sondeando cada tanto) sin pisar el límite, volvé a correr con ' +
          'LOADTEST_CONNECTION_RATE bajo (ver encabezado de este escenario).',
    );
  }
}

main().catch((e) => {
  console.error('Error corriendo el escenario 04:', e);
  process.exit(1);
});
