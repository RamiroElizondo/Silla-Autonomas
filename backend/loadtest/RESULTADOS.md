# Resultados de las pruebas de carga

Plantilla para completar DESPUÉS de correr los 4 escenarios de verdad en tu
máquina (ver `README.md`). Este archivo se entrega vacío a propósito: ni el
desarrollador ni Claude pudieron correr estas pruebas contra un backend real
con Postgres real (`npx prisma generate` no funciona en ese entorno), así
que no hay datos reales que reportar acá todavía.

No completes esta tabla con resultados del dry-run de plomería contra el
servidor de juguete (ver README) — esos números no significan nada sobre el
sistema real, son solo una prueba de que los scripts corren.

## Escenario 1 — estado público (cache)

| Fecha | Duración | Conexiones | Requests/seg | Latencia p50 (ms) | Latencia p99 (ms) | Errores | Notas |
|---|---|---|---|---|---|---|---|
| 2026-09-23 | 12.13s | 80 | 160 | 15 | 79 | 0 | Corrida real contra `localhost:3002` con `PROXY_SHARED_SECRET` seteado (80 IPs simuladas distintas). 2xx=1920, 4xx=0, 5xx=0 (los ~160 restantes de 2080 enviados quedaron en vuelo al cortar el timer, normal en autocannon). Confirma: (a) el caché `TtlCache` sostiene la carga sin tocar Postgres por cada request, y (b) el fix de multi-IP del script funciona — antes de este resultado hubo 2 corridas fallidas: una por rate-limit (todo el tráfico compartía la IP real, 239/2115 en 2xx) y otra por un `LOADTEST_SILLA_ID` que no existía en la base (404 en 3/4 de las requests, 480/2115 en 2xx). |

## Escenario 2 — checkout

| Fecha | Duración | Conexiones | Requests/seg | Latencia p50 (ms) | Latencia p99 (ms) | Errores | % 429 | % 5xx | Notas |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-23 | 11.01s | 15 | 3080 | 4 | 10 | 0 | 99.97% | 0% | Corrida real con `LOADTEST=true`, sin `TURNSTILE_SECRET_KEY`, misma IP simulada para todas las conexiones (a propósito, ver comentario del script). 33891 requests enviados, 2xx=1, 4xx=33875, 5xx=0. El grueso del 429 lo produce el `@Throttle` de `LIMITE_CHECKOUT` (6/min por IP) — no `MAX_PENDIENTES_POR_IP` como dice el comentario del archivo (el throttle de NestJS corta casi todo antes de llegar al controller); igual el resultado clave se sostiene: 0% de 5xx bajo ~3080 req/seg, el guard no se cae ni deja pasar de más. |


Recordatorio: un % alto de 429 es ESPERADO acá (todas las requests salen de
la misma IP simulada, ver README). Lo que importa es que **% 5xx = 0**.

## Escenario 3 — webhook Mercado Pago (con duplicados)

| Fecha | Duración | Conexiones | Requests/seg | Latencia p50 (ms) | Latencia p99 (ms) | Errores | ¿Se usó LOADTEST_EXTERNAL_REF? | Notas |
|---|---|---|---|---|---|---|---|---|
| 2026-09-23 | 10.03s | 30 | 2667 | 9 | 60 | 0 | No | Corrida a máxima velocidad (sin `LOADTEST_CONNECTION_RATE`, que todavía no existía en el script). 26695 requests, 2xx=300, 4xx=26365, 5xx=0. El 300 coincide EXACTO con `LIMITE_WEBHOOK` (300/min por IP, ver `throttle.config.ts`) — todo el tráfico salía de una sola IP simulada, así que el throttle del webhook se agotó casi al instante. No es un bug: confirma que ese límite se sostiene sin 5xx incluso a ~2700 req/seg. Se agregó `LOADTEST_CONNECTION_RATE` (opcional) al script para poder correr una versión más lenta que se quede debajo de 300 req totales y así ver el ~100% de 2xx bajo duplicados. |
| 2026-09-23 | 10.08s | 10 | 20 | 4 | 18 | 0 | No | Segunda corrida, con `LOADTEST_CONNECTION_RATE=2`. 220 requests enviados, 2xx=200, 4xx=0, 5xx=0 (los 20 restantes quedaron en vuelo, normal). Confirma lo que este escenario buscaba: notificaciones firmadas y duplicadas a propósito, manejadas al 100% con HTTP 200, sin que el rate limit interfiera. |


Si se usó `LOADTEST_EXTERNAL_REF`, anotar acá cuántos `Pago` quedaron
realmente en estado `APROBADO` en la tabla `pagos` para esa sesión (debería
ser **exactamente 1**, sin importar cuántas notificaciones duplicadas se
mandaron — eso es lo que confirma la idempotencia).

## Escenario 4 — panel admin

| Fecha | Duración | Conexiones | Requests/seg | Latencia p50 (ms) | Latencia p99 (ms) | Errores | Notas |
|---|---|---|---|---|---|---|---|
| 2026-09-23 | 10.11s | 10 | 20 | 14 | 213 | 0 | Con `LOADTEST_CONNECTION_RATE=2` (simula el dueño con varias pestañas, no un flood). 220 requests, 2xx=200, 4xx=0, 5xx=0 (20 en vuelo al cortar, normal). Latencia más alta que en el caché de estado (p99=213ms) porque son queries reales a Postgres, no cacheadas — esperable, no es un problema. |

## Observaciones generales / próximos pasos

- Los 4 escenarios se corrieron de verdad contra el backend real (`localhost:3002`, Postgres real) y terminaron con **0% de 5xx en los cuatro**, incluso bajo ráfagas de miles de requests/seg.
- En el camino se encontraron y corrigieron 2 problemas propios de los SCRIPTS de loadtest (no del sistema bajo prueba):
  1. **`01-estado-publico.ts`**: la simulación de multi-IP (`PROXY_SHARED_SECRET`) no funcionaba — `client.setHeaders()` solo pisaba el header de la primera request del array, dejando 3 de cada 4 requests sin IP simulada. Se corrigió usando `setupRequest` en cada request + sembrando `requestIterator.initialContext` (mecanismo interno de `autocannon`, confirmado leyendo su código fuente). Verificado además con un harness que ejercita el `RequestIterator` real de la librería instalada, sin red de por medio: 20 conexiones simuladas, cada una mantuvo su propia IP en el 100% de sus requests a través de varios ciclos.
  2. **`03-webhook.ts`** y **`04-admin-panel.ts`**: sin control de velocidad, `autocannon` manda todo a máxima velocidad desde una sola IP real, lo que agota el rate limit de esos endpoints (`LIMITE_WEBHOOK`=300/min, `LIMITE_GLOBAL`=240/min) casi al instante y hace parecer que el sistema falla cuando en realidad el límite está haciendo exactamente su trabajo. Se les agregó `LOADTEST_CONNECTION_RATE` (opcional, mismo mecanismo que ya tenía `01`) para poder simular tráfico realista por debajo de esos límites.
- Ninguno de estos dos hallazgos es un bug del backend — los límites de rate limiting se sostuvieron sin caerse (`5xx=0`) incluso en las corridas "a máxima velocidad" que sí los superaron a propósito.
- Pendiente si se quiere ir más a fondo: repetir el escenario 3 con `LOADTEST_EXTERNAL_REF` apuntando a una sesión `PAGO_PENDIENTE` real (generada por el escenario 2) para ver la idempotencia a nivel de base de datos bajo carga real, además de a nivel HTTP. No es indispensable — la idempotencia de base ya se probó de forma más rigurosa con `test:int` contra Postgres real.
