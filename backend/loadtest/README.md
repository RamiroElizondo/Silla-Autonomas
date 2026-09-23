# Pruebas de carga (`backend/loadtest/`)

Cuatro escenarios de carga con [`autocannon`](https://github.com/mcollina/autocannon)
(no `k6`: no está disponible ni en el entorno del desarrollador ni en el de
Claude — `autocannon` es un paquete npm, más simple de instalar y de usar
programáticamente desde TypeScript).

## ⚠️ Antes de correr NADA de esto

**Estos scripts NUNCA se ejecutaron contra el servidor real de este proyecto
ni contra una base de datos real.** Ni el desarrollador ni Claude pudieron
levantar el backend con una Postgres real conectada en su entorno (`npx
prisma generate` falla ahí con un error 403 contra `binaries.prisma.sh` — no
hay motor de Prisma disponible). Lo único que se verificó fue:

1. Que el código de los 4 escenarios compila sin errores de tipos
   (`npx tsc --noEmit`).
2. Que los tests unitarios del modo `LOADTEST=true` (ver más abajo) pasan.
3. Un **dry-run de plomería**: correr los 4 scripts contra un servidor HTTP
   de juguete (10 líneas, sin Nest ni Prisma) para confirmar que `autocannon`
   arranca, imprime el resumen y no explota por un error de código. Esto NO
   dice nada sobre el rendimiento real del sistema — ver el reporte de
   Claude para el detalle.

**Vos (el cliente) tenés que correr esto de verdad en tu máquina** antes de
sacar cualquier conclusión de performance. Los pasos:

### 1. Levantar una Postgres real y aplicar las migraciones

```bash
# Con Postgres corriendo y DATABASE_URL apuntando a él en tu .env:
npx prisma generate
npx prisma migrate deploy
```

### 2. Sembrar datos de prueba

```bash
npm run seed
```

Esto crea el usuario admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD` de tu `.env`) y,
si la tabla `sillas` está vacía, una silla de ejemplo. **Anotá el UUID de esa
silla** — lo vas a necesitar como `LOADTEST_SILLA_ID`:

```sql
SELECT id, nombre FROM sillas;
```

### 3. Arrancar el backend en modo LOADTEST

**NUNCA** en la base de datos ni la instancia de producción reales. Usá una
base de datos de prueba/desarrollo separada.

En tu `.env` (o exportado en la terminal antes de arrancar):

```bash
LOADTEST=true
```

y confirmá que **no** tenés `NODE_ENV=production` (el servidor aborta el
arranque si `LOADTEST=true` y `NODE_ENV=production` coinciden — es
intencional, ver `src/common/verificar-entorno.ts`). Para el escenario 2
(checkout), además dejá `TURNSTILE_SECRET_KEY` **sin configurar** en ese
`.env` de prueba (sin ella, `TurnstileService` queda deshabilitado y siempre
pasa — no hace falta ningún token real de Cloudflare Turnstile para el load
test).

```bash
npm run start:dev
# o: npm run build && npm run start
```

Con `LOADTEST=true`:
- `MercadoPagoService.crearPreferencia` y `.obtenerPago` devuelven
  respuestas simuladas, sin llamar al SDK real de Mercado Pago.
- `ShellyService.setRele` devuelve éxito inmediato, sin llamar a la Shelly
  Cloud API real.

Esto es necesario porque una prueba de carga real dispara muchas más
activaciones por segundo de las que tolera el sandbox de Mercado Pago o el
límite de ~1 req/seg de la Shelly Cloud API — sin el mock, el load test
terminaría gastando plata de sandbox y/o reventando ese límite en vez de
medir el propio backend.

### 4. Correr cada escenario

Con el servidor arriba en otra terminal:

```bash
export LOADTEST_BASE_URL=http://localhost:3001   # default; ajustar si PORT es otro
export LOADTEST_SILLA_ID=<uuid de la silla sembrada>

npm run loadtest:estado      # = ts-node loadtest/01-estado-publico.ts
npm run loadtest:checkout    # = ts-node loadtest/02-checkout.ts
npm run loadtest:webhook     # = ts-node loadtest/03-webhook.ts — necesita además MP_WEBHOOK_SECRET (el mismo del .env del server)
npm run loadtest:admin       # = ts-node loadtest/04-admin-panel.ts — necesita además ADMIN_EMAIL / ADMIN_PASSWORD (los del seed)
```

Cada script imprime, antes de arrancar: qué escenario es, contra qué URL
corre, y qué variables de entorno usó (con sus defaults). Al terminar,
imprime un resumen legible de latencia/throughput/errores — no el JSON
crudo de `autocannon`. Si el servidor no está arriba, o falta una variable
obligatoria, el script corta enseguida con un mensaje claro (no deja que
`autocannon` reporte cientos de `ECONNREFUSED` sin contexto).

Completá la tabla de `RESULTADOS.md` con lo que veas en cada corrida.

## Los 4 escenarios

| # | Archivo | Qué prueba |
|---|---|---|
| 1 | `01-estado-publico.ts` | `GET /sillas/:id/estado`, `GET /cola/estado`, `GET /cola/:id/estado` — el caché `TtlCache` (TTL 1.5s) absorbiendo ráfagas de polling concurrente. Concurrencia alta, duración corta. No necesita `LOADTEST=true` (son lecturas públicas). |
| 2 | `02-checkout.ts` | `POST /sillas/:id/checkout` (y opcionalmente `/cola/checkout`) — varios clientes iniciando pago a la vez. Necesita `LOADTEST=true` en el servidor. Como todas las requests de `autocannon` salen de la misma IP simulada, esto choca rápido con el tope `MAX_PENDIENTES_POR_IP` (default 3) y responde 429 — **es lo esperado, no un bug**: lo que se confirma es que ese 429 se sostiene estable bajo carga (nunca 500), no que todos los checkouts se acepten. |
| 3 | `03-webhook.ts` | `POST /webhooks/mercadopago`, con notificaciones **duplicadas a propósito** (mismo `payment_id` repetido muchas veces, por construcción: `autocannon` cicla un lote fijo de payloads pre-firmados durante toda la duración del test) para ejercitar la idempotencia bajo carga. Firma cada notificación con HMAC-SHA256, reproduciendo exactamente el algoritmo de `test/webhook-firma.e2e-spec.ts` / `MercadoPagoService.validarFirma`. Necesita `MP_WEBHOOK_SECRET` (el mismo valor configurado en el servidor). |
| 4 | `04-admin-panel.ts` | Se loguea una vez (`POST /admin/auth/login`) y reusa el JWT contra `GET /admin/sesiones`, `GET /admin/pagos/revision`, `GET /admin/metricas` — confirma que el uso normal del panel (varias pestañas, polling de métricas) no choca con el rate limit bajo carga moderada. Necesita `ADMIN_EMAIL`/`ADMIN_PASSWORD` (los del usuario sembrado). |

## El esquema de `LOADTEST` para simular pagos (Tarea 1)

Con `LOADTEST=true`, `MercadoPagoService.obtenerPago(paymentId)` interpreta
el `paymentId` recibido con el esquema:

```
loadtest:<externalReference>:<monto>
```

`03-webhook.ts` arma el `data.id` del webhook exactamente así. Si alguna vez
se cambia este esquema en `src/mercadopago/mercadopago.service.ts`, hay que
actualizar ese script en el mismo cambio (están documentados cruzados en los
comentarios de ambos archivos).

Para que el escenario 3 ejercite el flujo COMPLETO de activación (no solo el
throughput/latencia del endpoint), pasale `LOADTEST_EXTERNAL_REF` con el
`external_reference` de una `Sesion` real en estado `PAGO_PENDIENTE`
(conseguilo corriendo primero `02-checkout.ts` y consultando la base):

```sql
SELECT external_reference FROM sesiones ORDER BY creada_en DESC LIMIT 1;
```

Sin esa variable, el script genera `external_reference` sintéticos que no
matchean ninguna sesión real — el webhook los procesa igual (firma válida,
200 rápido) pero los ignora por "sesión no encontrada". Sigue siendo válido
para medir throughput/latencia y el manejo de duplicados a nivel HTTP, pero
no prueba la escritura real en la tabla `pagos`.

## Variables de entorno que reconocen los scripts

Comunes a los 4:

| Variable | Default | Descripción |
|---|---|---|
| `LOADTEST_BASE_URL` | `http://localhost:3001` | URL del backend bajo prueba. |
| `LOADTEST_CONNECTIONS` | según escenario | Conexiones concurrentes de `autocannon`. |
| `LOADTEST_DURATION_SEC` | según escenario | Duración de la corrida, en segundos. |

Específicas:

| Variable | Usada por | Descripción |
|---|---|---|
| `LOADTEST_SILLA_ID` | 01, 02 | UUID de una `Silla` sembrada (obligatoria). |
| `LOADTEST_TURNO_ID` | 01 | UUID de un `Turno` real, para incluir `GET /cola/:id/estado` (opcional). |
| `LOADTEST_INCLUIR_COLA` | 02 | `"true"` para sumar `POST /cola/checkout` al mix. |
| `MP_WEBHOOK_SECRET` | 03 | Mismo secreto configurado en el `.env` del servidor (obligatoria). |
| `LOADTEST_EXTERNAL_REF` | 03 | `external_reference` de una sesión real, para ejercitar el flujo completo (opcional, ver arriba). |
| `LOADTEST_MONTO` | 03 | Monto simulado del pago (default 3000). |
| `LOADTEST_PAGOS_UNICOS` | 03 | Cuántos payloads distintos armar antes de que `autocannon` empiece a repetirlos (default 15). |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 04 | Credenciales del usuario admin sembrado (obligatorias). |

## Qué NO hace falta tocar

`autocannon` ya está en `devDependencies` de `package.json`. No hace falta
instalar `k6` ni ningún otro binario — todo corre con Node.

## Verificación mecánica que sí se hizo (sin Postgres real)

- `npx tsc --noEmit` sobre los 4 scripts (sin errores de tipos).
- Dry-run de plomería contra un servidor HTTP de juguete (10 líneas, sin
  Nest ni Prisma): confirma que cada script corre de punta a punta sin
  crashear, imprime su resumen y respeta las variables de entorno. Las
  aserciones de negocio (status esperado en checkout, etc.) no tienen
  sentido contra ese servidor de juguete — esto solo confirma que el código
  de los scripts en sí funciona, no el comportamiento del backend real.
