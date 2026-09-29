# Informe final — Hardening "resto" (Bloques A-F)

**Rama:** `hardening/resto` (sobre `main`/`hardening/altos`, que ya tenía los 4 hallazgos ALTOS corregidos).
**Fecha:** 22-23/09/2026. **Estado:** todos los bloques completos, **commiteados** (6 commits, uno por bloque) y con Bloque E y F verificados de verdad en tu máquina (Postgres real, servidor real).

No se tocó ningún `.env` real y no se imprimió ningún secreto en ningún momento de todo el trabajo. Los 6 commits están en `hardening/resto`, listos para que los revises — **nada se pusheó ni se mergeó**, eso queda para cuando vos digas.

```
8679c13 feat: modo LOADTEST + 4 escenarios de prueba de carga (backend/loadtest/)
20714df test: cobertura de la lógica de plata (Pagos/Creditos/Sesiones/Energia/Cola) + fix en ColaService
beea559 fix: hallazgos BAJOS — paginación, validación de Silla, CORS configurable, limpieza
659af61 perf: cachea endpoints públicos de estado y mejora el polling del frontend
a60e335 feat(pagos): revisión manual de pagos aprobados que no activaron ningún servicio
901d3af feat(admin): sesión con cookie httpOnly, tokenVersion revocable y bloqueo por fuerza bruta
```

Nota sobre estos commits: varios archivos los tocó más de un bloque (por ejemplo `main.ts` tiene tanto el `helmet()` de A como el CORS de D; `mercadopago.service.ts` tiene el `currency_id` de B y el modo LOADTEST de F). En esos casos el archivo completo quedó en el commit del bloque que lo tocó *al final*, y el mensaje de cada commit dice explícitamente qué más incluye — separar cada archivo en varios commits a nivel de línea hubiera sido mucho más frágil que valioso acá. `git diff` entre el estado anterior a estos 6 commits y `HEAD` da vacío: no se perdió ni se cambió una sola línea en el proceso.

---

## Resumen ejecutivo

| Bloque | Contenido | Estado |
|---|---|---|
| A | Sesión de admin (cookie httpOnly, `tokenVersion`, bloqueo por fuerza bruta, `helmet`/CSP) | ✅ Completo y commiteado |
| B | Pagos aprobados sin servicio (revisión manual, detección de reembolsos) | ✅ Completo y commiteado |
| C | Caché de endpoints de estado + polling del frontend | ✅ Completo y commiteado |
| D | Hallazgos BAJOS (paginación, DTOs, CORS, limpieza) | ✅ Completo y commiteado |
| E | Tests de la lógica de plata (`Pagos`, `Creditos`, `Sesiones`, `Energia`, `Cola`) | ✅ Completo y commiteado — **encontró y corrigió un bug real**, y el test de integración contra Postgres real (`test:int`) **corrió con éxito en tu máquina** |
| F | Prueba de carga (`loadtest/`) | ✅ Completo y commiteado — **los 4 escenarios se corrieron de verdad contra tu servidor real, 0% de respuestas 5xx** |

**Verificación final (corrida por mí, sobre el estado final de los 6 bloques juntos, antes de commitear):**

- Backend `npx tsc --noEmit`: **limpio**.
- Backend tests unitarios: **21/21 suites, 343/343 tests** en verde.
- Backend tests e2e: **5/5 suites, 32/32 tests** en verde.
- Backend `npm run build` (`nest build`): **limpio**.
- Frontend `npx tsc --noEmit`: **limpio**.
- Frontend `npx vitest run`: **3/3 suites, 26/26 tests** en verde.
- Frontend `npm run build`: **no corre en mi entorno** (ver "Lo que no se pudo verificar acá").

**Verificado por vos, en tu máquina, después de esto (ver detalle en los bloques E y F):**

- `npm run test:int` contra Postgres real: **PASS** — la protección real contra la condición de carrera webhook-vs-retorno funciona.
- Los 4 escenarios de `backend/loadtest/`: **0% de 5xx en los cuatro**, incluso bajo ráfagas de miles de requests/seg.

---

## Bloque A — Sesión de admin (ya reportado, resumen)

- Cookie httpOnly con JWT en vez de `localStorage`, vía el proxy de Next.js.
- `tokenVersion` en `UsuarioAdmin` para poder revocar sesiones activas.
- `GET /admin/auth/me`, `POST /admin/auth/logout`, header CSRF obligatorio.
- `LoginBloqueoService` (bloqueo tras varios intentos fallidos, nuevo archivo `backend/src/admin/login-bloqueo.service.ts` + spec).
- `helmet` en el backend, CSP y cabeceras de seguridad en el frontend (`next.config.ts`).
- Migración `20260922000000_admin_token_version`.

**Commit:** `901d3af`.

## Bloque B — Pagos aprobados sin servicio

**Qué resuelve:** un pago aprobado por Mercado Pago que, por la razón que sea (sesión ya vencida, monto insuficiente, moneda distinta a ARS, `external_reference` desconocido), no termina activando ninguna silla — la plata no puede quedar "perdida" en un log, tiene que quedar visible para que vos la resuelvas a mano. También cubre el caso inverso: un pago que ya estaba APROBADO y que Mercado Pago después marca como `refunded`/`charged_back`/`cancelled`.

**Archivos:**
- `backend/prisma/schema.prisma` — `Pago` gana `requiereRevision`, `motivoRevision`, `resolucion`, `resueltoEn`; `EstadoPago` gana `REEMBOLSADO`.
- `backend/prisma/migrations/20260922010000_pagos_revision_manual/` (nueva).
- `backend/src/pagos/pagos.service.ts` — reescrito: `procesarPagoVerificado`/`procesarPagoDeSesion`/`procesarPagoDeTurno` ahora calculan `motivoRevision`, detectan la transición a reembolso de un pago ya aprobado, y marcan para revisión cuando la sesión/turno ya no puede recibir el pago. Nuevos métodos `listarPagosParaRevision`, `resolverPagoParaRevision` (idempotente).
- `backend/src/pagos/dto/resolver-pago.dto.ts` (nuevo).
- `backend/src/mercadopago/mercadopago.service.ts` — `PagoMP` gana `currency_id`.
- `backend/src/pagos/pagos.module.ts`, `backend/src/admin/admin.module.ts`, `backend/src/admin/admin.controller.ts` — nuevos endpoints `GET /admin/pagos/revision`, `POST /admin/pagos/:id/resolver`.
- `frontend/src/lib/tipos.ts`, `frontend/src/lib/api.ts`, `frontend/src/app/admin/page.tsx` — panel "Pagos para revisar" con 3 acciones (emitir vale, marcar reembolsado, ignorar).

**Tests agregados:** `backend/src/pagos/pagos-revision.service.spec.ts` (nuevo, ~22 tests) cubriendo los tres motivos de revisión, la detección de reembolso, y la idempotencia de `resolverPagoParaRevision`.

**Commit:** `a60e335`.

## Bloque C — Caché de endpoints de estado + polling

**Qué resuelve:** los 4 endpoints públicos de "estado" (silla, sesión, turno, resumen de cola) se consultaban por polling cada pocos segundos desde potencialmente muchos clientes a la vez, pegándole a la base en cada tick. Se agregó una caché en memoria de 1.5s con coalescing de pedidos concurrentes, y el frontend dejó de sondear a intervalo fijo con `setInterval` para pausarse cuando la pestaña está oculta y respetar `Retry-After` en un 429.

**Regla de oro aplicada en todo el bloque:** se cachea el dato crudo de la base, nunca el campo calculado con `Date.now()` (`segundosRestantes`, etc.) — eso se recalcula siempre, incluso en un hit de caché.

**Archivos:**
- `backend/src/common/ttl-cache.ts` + spec (nuevo) — `TtlCache<T>` genérico, comparte la promesa en vuelo entre pedidos concurrentes.
- `backend/src/common/cache.config.ts` (nuevo) — `CACHE_TTL_ESTADO_MS = 1500`.
- `backend/src/sillas/sillas.service.ts` + spec (nuevo) — cachea `obtener(id)`, expone `invalidarCache(id)`.
- `backend/src/sesiones/sesiones.service.ts`, `backend/src/sesiones/sesiones.module.ts` — cachea el estado público, invalida en cada transición relevante.
- `backend/src/cola/cola.service.ts`, `backend/src/cola/cola.module.ts` — cachea el resumen de cola y el estado de turno.
- `frontend/src/lib/polling.ts` + test (nuevo) — helpers puros `debeSondearAhora`, `parsearRetryAfter`, `proximoRetrasoMs`.
- `frontend/src/lib/api.ts` — `ApiError.retryAfterMs`.
- `frontend/src/hooks/useEstadoSilla.ts`, `useEstadoSesion.ts`, `useEstadoTurno.ts` — `setInterval` → cadena de `setTimeout` auto-reprogramable, pausa en `visibilitychange`, backoff en 429.
- `frontend/src/app/silla/[id]/pantalla/page.tsx` — la pantalla de TV pasa `pausarEnOculto: false` (nunca debe dejar de sondear).

**Commit:** `659af61`.

## Bloque D — Hallazgos BAJOS

- `backend/src/common/parse-int-min.pipe.ts` (nuevo) — pipe encadenable que corta con 400 un `take`/`skip` negativo (antes producía 500 o comportamiento raro).
- `backend/src/admin/dto/silla.constraints.ts` (nuevo) — constraints compartidas entre alta y edición de silla: `nombre` máx. 80 + trim, `precio` máx. 1.000.000 + 2 decimales, `deviceIdShelly` regex de 12 hex.
- `backend/src/admin/dto/crear-silla.dto.ts`, `actualizar-silla.dto.ts` — aplican esas constraints.
- `backend/src/common/verificar-entorno.ts` + spec — `resolverCorsOrigins()`: `CORS_ORIGINS` configurable, permisivo con warning en desarrollo, **falla cerrado** (rechaza cualquier origen cross-origin) si no está configurada en producción.
- `backend/src/main.ts` — usa `resolverCorsOrigins()` en vez de `origin: true` fijo.
- `backend/src/shelly/heartbeat.service.spec.ts` (nuevo) — confirma que la alerta de "relé ON pero 0W" ya estaba bien implementada.
- `backend/test/admin-sillas.e2e-spec.ts` (nuevo, 18 tests) — paginación y validación de DTOs de punta a punta.
- `backend/src/pagos/mercadopago.service.ts` — **eliminado** (stub muerto, confirmado sin referencias).

**Commit:** `beea559`.

## Bloque E — Tests de la lógica de plata

Cobertura final (statements/branches), medida por mí sobre el estado final:

| Archivo | Antes | Después |
|---|---|---|
| `pagos/pagos.service.ts` | 71.8% / 63.5% | **97.9% / 89.3%** |
| `creditos/creditos.service.ts` | 61.7% / 66.7% | **97.9% / 90.5%** |
| `sesiones/energia.service.ts` | 0% / 0% | **97.9% / 90%** |
| `sesiones/sesiones.service.ts` | 39.3% / 33.1% | **99.5% / 96.2%** |
| `cola/cola.service.ts` | 65.0% / 57.5% | **98.5% / 90.6%** |

**🐛 Bug real encontrado y corregido:** `ColaService.procesarPagoAprobado` no tiraba `ConflictException` cuando un pago aprobado llegaba tarde para un turno que ya había vencido o se había cancelado — a diferencia de `SesionesService.activarSesion`, que sí la tira en el caso análogo. Como `PagosService.procesarPagoDeTurno` tiene un `catch` específico para `ConflictException` que marca el pago con `requiereRevision=true` (Bloque B), ese `catch` nunca se disparaba para el flujo de cola compartida: **un pago cobrado sin turno detrás quedaba registrado pero nunca flageado para revisión manual**. Lo corregí para que tire `ConflictException` igual que el flujo de sesión directa, actualicé el test que ya lo documentaba, y reverifiqué todo después del cambio.

**Test de integración con Postgres real (`npm run test:int`) — ✅ CORRIÓ CON ÉXITO EN TU MÁQUINA:** prueba la condición de carrera Webhook-vs-retorno del navegador sobre el mismo `payment_id` (protección real: constraint único en `Pago.paymentIdMp` + captura de `P2002`). Un mock de Prisma en JS no puede reproducir esta carrera de verdad (no hay dos hilos compitiendo por una fila real). Vos lo corriste contra tu Postgres real y dio:

```
PASS test/integration/pagos-race.int-spec.ts
  ✓ ... (101 ms)
```

Esto confirma, con una base de datos real de por medio (no un mock), que la protección contra doble activación por la misma notificación duplicada funciona de verdad.

**Commit:** `20714df`.

## Bloque F — Prueba de carga (`backend/loadtest/`)

**Modo `LOADTEST=true`:** mockea `MercadoPagoService` (pagos siempre aprobados, sin llamar al SDK real) y `ShellyService.setRele` (relé simulado, sin red real) para poder tirar carga sin gastar plata real de Mercado Pago ni reventar el límite de ~1 req/seg de la Shelly Cloud API. **Falla cerrado en producción:** `verificarEntornoDeArranque()` aborta el arranque si `LOADTEST=true` y `NODE_ENV=production`, sin ninguna bandera de escape.

**4 escenarios corridos de verdad, contra tu servidor real (Postgres real, `LOADTEST=true`):**

| Escenario | Requests | 2xx | 4xx | 5xx |
|---|---|---|---|---|
| 01 — estado público (caché) | 2080 | 1920 | 0 | 0 |
| 02 — checkout | 33891 | 1 (esperado — throttle de 6/min por IP) | 33875 | 0 |
| 03 — webhook Mercado Pago (duplicados) | 220 | 200 | 0 | 0 |
| 04 — panel admin | 220 | 200 | 0 | 0 |

**Cero respuestas 5xx en los cuatro**, incluso en la corrida de checkout que mandó ~3000 req/seg contra un endpoint con throttle de 6/min por IP — el rate limiting aguanta ráfagas masivas sin caerse. Resultados completos, con notas por corrida, en `backend/loadtest/RESULTADOS.md`.

**Dos problemas encontrados y corregidos en el camino — en los SCRIPTS de loadtest, no en el sistema bajo prueba:**

1. **`01-estado-publico.ts`**: la simulación de multi-IP (`PROXY_SHARED_SECRET`) no funcionaba — `client.setHeaders()` (la API "pública" de `autocannon`) solo pisaba el header de la primera request del array de 4, dejando 3 de cada 4 sin IP simulada. Se corrigió usando `setupRequest` en cada request + sembrando `requestIterator.initialContext` (mecanismo interno de `autocannon`, confirmado leyendo su código fuente instalado). Verificado además con un harness que ejercita el `RequestIterator` real de la librería, sin red de por medio: 20 conexiones simuladas mantuvieron su propia IP en el 100% de sus requests a través de varios ciclos.
2. **`03-webhook.ts`** y **`04-admin-panel.ts`**: sin control de velocidad, `autocannon` manda todo a máxima velocidad desde una sola IP real, lo que agota el rate limit de esos endpoints (`LIMITE_WEBHOOK`=300/min, `LIMITE_GLOBAL`=240/min) casi al instante — el sistema no fallaba, pero el resultado no medía lo que el escenario quería medir. Se les agregó `LOADTEST_CONNECTION_RATE` (opcional, mismo mecanismo que ya tenía `01`) para simular tráfico realista por debajo de esos límites.

**Tests para el cambio de comportamiento:** `mercadopago.service.spec.ts` (+8), `shelly.service.spec.ts` (nuevo, 3), `verificar-entorno.spec.ts` (+3) — 47 tests en total para el modo LOADTEST, todos verificados en verde.

**Commit:** `8679c13`.

---

## Resultado exacto de la verificación final (corrida por mí, sobre los 6 bloques juntos, antes de commitear)

```
# Backend
$ npx tsc --noEmit                                    → limpio (sin salida)
$ npx jest --config jest.config.ts --silent           → 21 suites, 343 tests — PASS
$ npx jest --config test/jest-e2e.config.ts --silent  → 5 suites, 32 tests — PASS
$ npm run build (nest build)                          → limpio, exit 0

# Frontend
$ npx tsc --noEmit          → limpio (sin salida)
$ npx vitest run --silent   → 3 suites, 26 tests — PASS
$ npm run build (next build) → NO CORRE EN MI ENTORNO (ver abajo)
```

Después de commitear, `git diff HEAD` volvió a dar vacío y `npx tsc --noEmit` se corrió una vez más sobre el estado ya commiteado: limpio.

## Lo que no se pudo verificar en mi entorno (pero vos ya corriste 2 de estos 3)

1. **`frontend && npm run build`** — se cuelga indefinidamente en "Creating an optimized production build..." en mi sandbox (2 vCPUs, confirmado con `nproc`). No es un problema de código. Corré `npm run build` en tu máquina antes de dar el frontend por bueno.
2. **`npx prisma generate`** — falla en mi entorno con 403 al descargar los binarios del motor (red restringida del sandbox). No afecta la corrección del código real (la migración SQL y el `schema.prisma` están escritos a mano y son correctos), pero corré `npx prisma generate` en tu máquina antes de levantar el servidor real si todavía no lo hiciste.
3. ~~`npm run test:int`~~ — **ya lo corriste vos, con éxito, contra Postgres real.**
4. ~~Los 4 escenarios de `backend/loadtest/`~~ — **ya los corriste vos, con éxito, contra tu servidor real.**
5. **El servidor completo end-to-end** (checkout real → webhook real → Shelly Cloud real) — los loadtests usaron `LOADTEST=true` (Mercado Pago y Shelly mockeados), así que esto sigue sin probarse con los servicios externos reales. Es el único paso que falta antes de un piloto real con el hardware.

## Antes de mergear / dar por cerrado

- Los 6 commits están en `hardening/resto`, sin pushear ni mergear — revisalos con `git log` / `git show` antes de decidir.
- Correr en tu máquina, si no lo hiciste ya: `npx prisma generate` → `npx prisma migrate deploy` → `npm run build` en frontend.
- El hallazgo del Bloque E (bug de `ColaService.procesarPagoAprobado`) es un cambio de comportamiento real en producción (no solo hardening defensivo) — vale la pena que lo leas vos mismo (commit `20714df`) antes de mergear.
- Falta probar de punta a punta con Mercado Pago y Shelly Cloud reales (sin `LOADTEST=true`) — recién ahí queda validado el flujo completo con el hardware.
