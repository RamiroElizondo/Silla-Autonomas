# Informe final — Hardening "resto" (Bloques A-F)

**Rama:** `hardening/resto` (sobre `main`/`hardening/altos`, que ya tenía los 4 hallazgos ALTOS corregidos).
**Fecha:** 22/09/2026. **Estado:** todos los bloques completos, sin commits (a la espera de tu aprobación).

No se tocó ningún `.env` real, no se imprimió ningún secreto, y no se hizo ningún `git commit` en todo el trabajo — está todo como cambios sin confirmar en el working tree de `hardening/resto`, listo para que lo revises.

---

## Resumen ejecutivo

| Bloque | Contenido | Estado |
|---|---|---|
| A | Sesión de admin (cookie httpOnly, `tokenVersion`, bloqueo por fuerza bruta, `helmet`/CSP) | ✅ Completo |
| B | Pagos aprobados sin servicio (revisión manual, detección de reembolsos) | ✅ Completo |
| C | Caché de endpoints de estado + polling del frontend | ✅ Completo |
| D | Hallazgos BAJOS (paginación, DTOs, CORS, limpieza) | ✅ Completo |
| E | Tests de la lógica de plata (`Pagos`, `Creditos`, `Sesiones`, `Energia`, `Cola`) | ✅ Completo — **encontró y corrigió un bug real** |
| F | Prueba de carga (`loadtest/`) | ✅ Andamiaje completo — **no ejecutable en este entorno**, a correr por vos |

**Verificación final (todo corrido por mí, en tu máquina, recién ahora sobre el estado final de los 6 bloques juntos):**

- Backend `npx tsc --noEmit`: **limpio**.
- Backend tests unitarios: **21/21 suites, 343/343 tests** en verde.
- Backend tests e2e: **5/5 suites, 32/32 tests** en verde.
- Backend `npm run build` (`nest build`): **limpio**.
- Frontend `npx tsc --noEmit`: **limpio**.
- Frontend `npx vitest run`: **3/3 suites, 26/26 tests** en verde.
- Frontend `npm run build`: **no corre en este entorno** (ver "Lo que no se pudo verificar acá").

---

## Bloque A — Sesión de admin (ya reportado, resumen)

- Cookie httpOnly con JWT en vez de `localStorage`, vía el proxy de Next.js.
- `tokenVersion` en `UsuarioAdmin` para poder revocar sesiones activas.
- `GET /admin/auth/me`, `POST /admin/auth/logout`, header CSRF obligatorio.
- `LoginBloqueoService` (bloqueo tras varios intentos fallidos, nuevo archivo `backend/src/admin/login-bloqueo.service.ts` + spec).
- `helmet` en el backend, CSP y cabeceras de seguridad en el frontend (`next.config.ts`).
- Migración `20260922000000_admin_token_version`.

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

## Bloque C — Caché de endpoints de estado + polling

**Qué resuelve:** los 4 endpoints públicos de "estado" (silla, sesión, turno, resumen de cola) se consultaban por polling cada pocos segundos desde potencialmente muchos clientes a la vez, pegándole a la base en cada tick. Se agregó una caché en memoria de 1.5s con coalescing de pedidos concurrentes, y el frontend dejó de sondear a intervalo fijo con `setInterval` para pausarse cuando la pestaña está oculta y respetar `Retry-After` en un 429.

**Regla de oro aplicada en todo el bloque:** se cachea el dato crudo de la base, nunca el campo calculado con `Date.now()` (`segundosRestantes`, etc.) — eso se recalcula siempre, incluso en un hit de caché.

**Archivos:**
- `backend/src/common/ttl-cache.ts` + spec (nuevo) — `TtlCache<T>` genérico, comparte la promesa en vuelo entre pedidos concurrentes.
- `backend/src/common/cache.config.ts` (nuevo) — `CACHE_TTL_ESTADO_MS = 1500`.
- `backend/src/sillas/sillas.service.ts` + spec (nuevo) — cachea `obtener(id)`, expone `invalidarCache(id)`.
- `backend/src/sesiones/sesiones.service.ts`, `backend/src/sesiones/sesiones.module.ts` — cachea el estado público, invalida en cada transición relevante.
- `backend/src/cola/cola.service.ts`, `backend/src/cola/cola.module.ts` — cachea el resumen de cola y el estado de turno; un punto de invalidación quedó deliberadamente sin cablear para no crear una dependencia circular de módulos — documentado en el código, cubierto igual por el TTL de 1.5s.
- `frontend/src/lib/polling.ts` + test (nuevo) — helpers puros `debeSondearAhora`, `parsearRetryAfter`, `proximoRetrasoMs`.
- `frontend/src/lib/api.ts` — `ApiError.retryAfterMs`.
- `frontend/src/hooks/useEstadoSilla.ts`, `useEstadoSesion.ts`, `useEstadoTurno.ts` — `setInterval` → cadena de `setTimeout` auto-reprogramable, pausa en `visibilitychange`, backoff en 429.
- `frontend/src/app/silla/[id]/pantalla/page.tsx` — la pantalla de TV pasa `pausarEnOculto: false` (nunca debe dejar de sondear).

## Bloque D — Hallazgos BAJOS

- `backend/src/common/parse-int-min.pipe.ts` (nuevo) — pipe encadenable que corta con 400 un `take`/`skip` negativo (antes producía 500 o comportamiento raro).
- `backend/src/admin/dto/silla.constraints.ts` (nuevo) — constraints compartidas entre alta y edición de silla: `nombre` máx. 80 + trim, `precio` máx. 1.000.000 + 2 decimales, `deviceIdShelly` regex de 12 hex.
- `backend/src/admin/dto/crear-silla.dto.ts`, `actualizar-silla.dto.ts` — aplican esas constraints (`ActualizarSillaDto` además suma `@IsNotEmpty()` en los campos opcionales, para que no se puedan vaciar con string vacío — mejora más allá de lo pedido literal).
- `backend/src/common/verificar-entorno.ts` + spec — `resolverCorsOrigins()`: `CORS_ORIGINS` configurable, permisivo con warning en desarrollo, **falla cerrado** (rechaza cualquier origen cross-origin) si no está configurada en producción.
- `backend/src/main.ts` — usa `resolverCorsOrigins()` en vez de `origin: true` fijo.
- `backend/src/shelly/heartbeat.service.spec.ts` (nuevo) — confirma que la alerta de "relé ON pero 0W" ya estaba bien implementada (`potenciaW !== null`).
- `backend/test/admin-sillas.e2e-spec.ts` (nuevo, 18 tests) — paginación y validación de DTOs de punta a punta.
- `backend/src/pagos/mercadopago.service.ts` — **eliminado** (stub muerto, confirmado sin referencias).
- `backend/README.md`, `backend/.env.example` — documentan `CORS_ORIGINS` y los endpoints nuevos de Bloque B.

## Bloque E — Tests de la lógica de plata

Cobertura final (statements/branches), medida por mí sobre el estado final:

| Archivo | Antes | Después |
|---|---|---|
| `pagos/pagos.service.ts` | 71.8% / 63.5% | **97.9% / 89.3%** |
| `creditos/creditos.service.ts` | 61.7% / 66.7% | **97.9% / 90.5%** |
| `sesiones/energia.service.ts` | 0% / 0% | **97.9% / 90%** |
| `sesiones/sesiones.service.ts` | 39.3% / 33.1% | **99.5% / 96.2%** |
| `cola/cola.service.ts` | 65.0% / 57.5% | **98.5% / 90.6%** |

Todos por encima del piso del 80% que pediste para `pagos/`, `creditos/` y `sesiones/energia.service.ts`.

**Archivos:** `backend/src/pagos/pagos.service.spec.ts` (+28 tests), `backend/src/creditos/creditos.service.spec.ts` (+10), `backend/src/sesiones/energia.service.spec.ts` (nuevo, 32), `backend/src/sesiones/sesiones.service.spec.ts` (+71), `backend/src/cola/cola.service.spec.ts` (+32).

**🐛 Bug real encontrado y corregido:** `ColaService.procesarPagoAprobado` (`backend/src/cola/cola.service.ts`) no tiraba `ConflictException` cuando un pago aprobado llegaba tarde para un turno que ya había vencido o se había cancelado — a diferencia de `SesionesService.activarSesion`, que sí la tira en el caso análogo. Como `PagosService.procesarPagoDeTurno` tiene un `catch` específico para `ConflictException` que marca el pago con `requiereRevision=true` (Bloque B), ese `catch` nunca se disparaba para el flujo de cola compartida: **un pago cobrado sin turno detrás quedaba registrado pero nunca flageado para revisión manual**. Lo corregí para que tire `ConflictException` igual que el flujo de sesión directa, actualicé el test que ya lo documentaba, y reverifiqué todo (tsc, 329 tests unitarios, 32 e2e, build) después del cambio.

**Test de integración con Postgres real (`npm run test:int`):** nuevo, para la condición de carrera Webhook-vs-retorno del navegador sobre el mismo `payment_id` (protección real: constraint único en `Pago.paymentIdMp` + captura de `P2002`). Un mock de Prisma en JS no puede reproducir esta carrera de verdad (no hay dos hilos compitiendo por una fila real). Archivos: `backend/test/integration/jest-integration.config.ts`, `backend/test/integration/pagos-race.int-spec.ts`. **Nunca se ejecutó con éxito en este entorno** (sin Postgres real disponible) — solo se confirmó que compila limpio y que falla con el mensaje esperado si falta `TEST_DATABASE_URL`. Para correrlo de verdad:

```
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/silla_test \
  npx prisma migrate deploy --schema=./prisma/schema.prisma
npm run test:int
```

(nunca usa `DATABASE_URL` como fallback, a propósito — para no correr esto por error contra una base real).

## Bloque F — Prueba de carga (`backend/loadtest/`)

**Modo `LOADTEST=true`:** mockea `MercadoPagoService` (pagos siempre aprobados, sin llamar al SDK real) y `ShellyService.setRele` (relé simulado, sin red real) para poder tirar carga sin gastar plata real de Mercado Pago ni reventar el límite de ~1 req/seg de la Shelly Cloud API. **Falla cerrado en producción:** `verificarEntornoDeArranque()` aborta el arranque si `LOADTEST=true` y `NODE_ENV=production` — sin ninguna bandera de escape, a diferencia de otras variables de este mismo archivo, porque acá no hay ningún escenario legítimo en producción.

**4 escenarios** (`backend/loadtest/01-estado-publico.ts` a `04-admin-panel.ts`, más `_util.ts` compartido), cada uno documentado con qué mide y qué necesita. `backend/loadtest/README.md` explica cómo levantar todo en tu máquina (Postgres real, migraciones, seed, `LOADTEST=true`) y `backend/loadtest/RESULTADOS.md` es una plantilla vacía para que vuelques los números reales.

**⚠️ Nunca se ejecutaron los 4 escenarios contra el servidor real ni contra Postgres real** — ni en mi entorno ni en el tuyo todavía. Solo se hizo un dry-run de plomería contra un servidor HTTP de juguete (sin Nest ni Prisma) para confirmar que los scripts de `autocannon` corren de punta a punta sin errores de código. Tenés que correrlos vos en tu máquina siguiendo el README antes de sacar cualquier conclusión de performance real.

**Tests para el cambio de comportamiento:** `mercadopago.service.spec.ts` (+8), `shelly.service.spec.ts` (nuevo, 3), `verificar-entorno.spec.ts` (+3) — 47 tests en total para el modo LOADTEST, todos verificados en verde por mí.

---

## Resultado exacto de la verificación final (corrida por mí, ahora, sobre los 6 bloques juntos)

```
# Backend
$ npx tsc --noEmit                                    → limpio (sin salida)
$ npx jest --config jest.config.ts --silent           → 21 suites, 343 tests — PASS
$ npx jest --config test/jest-e2e.config.ts --silent  → 5 suites, 32 tests — PASS
$ npm run build (nest build)                          → limpio, exit 0

# Frontend
$ npx tsc --noEmit          → limpio (sin salida)
$ npx vitest run --silent   → 3 suites, 26 tests — PASS
$ npm run build (next build) → NO CORRE EN ESTE ENTORNO (ver abajo)
```

## Lo que no se pudo verificar en este entorno (corré esto vos)

1. **`frontend && npm run build`** — se cuelga indefinidamente en "Creating an optimized production build..." en este sandbox. Confirmado con `nproc` que la máquina virtual de este entorno tiene **2 vCPUs**; no es un problema de código (lo reconfirmé recién, sin cambios respecto a antes de este hardening). Corré `npm run build` en tu máquina antes de dar el frontend por bueno.
2. **`npx prisma generate`** — falla en este entorno con 403 al descargar los binarios del motor desde `binaries.prisma.sh` (red restringida del sandbox). Por eso los tests corren contra el cliente de Prisma que ya estaba generado, parcheado a mano solo en sus *tipos* (`.d.ts`, nunca commiteado, vive en `node_modules`) para que `tsc` reconozca los campos nuevos del schema. Esto **no afecta la corrección del código real** (la migración SQL y el `schema.prisma` están escritos a mano y son correctos), pero corré `npx prisma generate` en tu máquina antes de levantar el servidor real.
3. **`npm run test:int`** (Bloque E) — necesita una Postgres de prueba real. Nunca se ejecutó con éxito acá.
4. **Los 4 escenarios de `backend/loadtest/`** (Bloque F) — necesitan un servidor Nest real + Postgres real corriendo. Nunca se ejecutaron acá salvo el dry-run de plomería mencionado arriba.
5. **El servidor completo end-to-end** (checkout real → webhook real → Shelly Cloud real) nunca se ejecutó en ningún momento de todo este hardening, por las mismas dos razones (1) y (2). Todo lo verificado acá es a nivel de tests unitarios/e2e con Prisma y servicios externos mockeados, más `tsc`/`build` — que es exactamente lo que sí se puede verificar sin una base y un servidor reales.

## Antes de mergear / dar por cerrado

- Nada de esto está commiteado — dijiste que no hiciera commits sin que los pidas. Cuando estés listo, puedo armar un commit lógico por bloque (A ya estaba, B/C/D/E/F son 5 commits separados) sobre `hardening/resto`.
- Correr en tu máquina, en este orden: `npx prisma generate` → `npx prisma migrate deploy` (las 2 migraciones nuevas de este hardening) → la suite completa una vez más con Postgres real de por medio (aunque los mocks ya lo cubren, no está de más) → `npm run build` en frontend → `npm run test:int` → los 4 escenarios de `loadtest/`.
- Revisar el hallazgo del Bloque E (el bug de `ColaService.procesarPagoAprobado`) — ya está corregido y testeado, pero como es un cambio de comportamiento real en producción (no solo hardening defensivo) vale la pena que lo leas vos mismo antes de aprobar el commit.
