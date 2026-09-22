# PROMPT 2 — Resto de hallazgos (medios, bajos, tests de dinero y prueba de carga)

Copiá todo lo que sigue en un chat nuevo, con la carpeta `Silla-Autonomas` conectada. **Ejecutalo después del Prompt 1** (o sobre la rama `hardening/altos` ya integrada).

---

## Contexto

Trabajás sobre el repo `Silla-Autonomas` (backend Nest.js 10 + Prisma 5 + PostgreSQL en `backend/`, frontend Next.js en `frontend/`). Es un sistema de autoservicio de sillas masajeadoras: el cliente paga con Mercado Pago Checkout Pro, el backend valida el pago (webhook firmado + consulta a la API de MP + idempotencia por `payment_id_mp` único) y enciende un relé Shelly por la Cloud Control API v2. Hay pago directo a una silla (`Sesion`), cola compartida (`Turno`), y vales por cortes de energía (`Credito`). El navegador solo habla con el proxy `frontend/src/app/api/[...path]/route.ts`, que reenvía al backend.

Una auditoría previa listó hallazgos. Los 4 de gravedad ALTA (rate limit con IP real, checkout sin pagar/Turnstile, vales adivinables, webhook fail-open) los cubre el Prompt 1. Acá hacés **todo lo demás**. Antes de empezar verificá que el Prompt 1 esté aplicado: debe existir un `ThrottlerGuard` propio con `getTracker` que usa `x-client-ip` + `PROXY_SHARED_SECRET`, `throttle.config.ts`, y Jest configurado. Si no está, avisame y frená.

**Fuera de alcance:** cualquier cosa de despliegue (VPS, Nginx, dominio, Certbot, PM2, backups, monitoreo externo). Tampoco decisiones comerciales (elegir entre Shelly 1 Gen3 y 1PM). No toques `.env` ni imprimas secretos. No hagas commit sin que yo lo pida.

## Reglas de trabajo

1. Leé los archivos indicados y armá un plan corto por bloque; mostrámelo y esperá mi OK antes de codear.
2. Todo cambio de comportamiento lleva test. Nada se da por terminado sin `npx tsc --noEmit`, `npm test`, `npm run test:e2e` y `npm run build` (backend) y `npm run build` (frontend) en verde.
3. Si tu entorno no puede correr algo (Prisma engines, build de Next, una base de datos de test), decímelo y dame el comando exacto para que lo corra yo. No lo marques como verificado.
4. Rama `hardening/resto`. Un commit lógico por bloque cuando yo lo apruebe.
5. Informe final: cambios por archivo, tests agregados, resultado de cada comando, y lo que quedó sin verificar.

## Bloque A — Sesión de admin (hallazgo MEDIO)

**Problema.** El token JWT (8 h) se guarda en `localStorage` (`frontend/src/app/admin/page.tsx`, clave `admin_token`): un XSS lo roba y no hay forma de revocarlo. Hay un único usuario, sin bloqueo por cuenta y sin `helmet`.

**Qué hacer.**

1. **Cookie httpOnly.** El login pasa por el proxy de Next: al recibir el `{ token }` del backend en `POST /api/admin/auth/login`, el proxy setea una cookie `admin_session` con `HttpOnly; Secure` (Secure solo si la request es HTTPS, para que ande en desarrollo local); `SameSite=Strict; Path=/api/admin; Max-Age` igual al JWT; y **no** devuelve el token en el body. En las requests a `/api/admin/*` el proxy lee la cookie y la traduce a `Authorization: Bearer` hacia el backend (el backend sigue igual). Agregar `POST /api/admin/auth/logout` que borra la cookie. Quitar todo uso de `localStorage` en el admin y `Authorization` del lado del navegador; el frontend detecta sesión con un `GET /admin/auth/me` (nuevo, protegido por el guard).
2. **CSRF:** con `SameSite=Strict` alcanza como base, pero además exigir un header `X-Requested-With: sillas-admin` en todo método no-GET a `/api/admin/*` (rechazar con 403 si falta).
3. **Revocación:** agregar `tokenVersion Int @default(0)` a `UsuarioAdmin` (migración a mano) e incluirlo en el JWT; `JwtAuthGuard` lo compara con la base y rechaza tokens viejos. El logout incrementa la versión (invalida todas las sesiones). Endpoint `POST /admin/auth/logout`.
4. **Bloqueo por cuenta:** tras 10 intentos fallidos por email en 15 minutos, bloquear ese email 15 minutos (429 con mensaje genérico, sin revelar si el email existe). Independiente del límite por IP. Servicio en memoria con TTL; contar también los intentos contra emails inexistentes para no filtrar existencia.
5. **helmet** en el backend (con la configuración adecuada para una API) y **cabeceras de seguridad + CSP** en el frontend (`next.config.ts` → `headers()`): `Content-Security-Policy` restrictiva permitiendo el widget de Turnstile del Prompt 1 y Google Fonts (Outfit), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'` salvo lo que necesite la vista TV (verificalo). Probá que la app siga funcionando con la CSP.

**Tests.** Guard: token válido, expirado, `tokenVersion` viejo, sin token. Login: éxito, fallo, bloqueo tras 10 fallos, desbloqueo al pasar el tiempo (timers falsos), no revela existencia del email. Logout invalida tokens previos. Proxy: setea cookie con los flags correctos, no expone el token en el body, traduce cookie → Bearer, rechaza mutaciones sin `X-Requested-With`. E2E de las rutas nuevas (`me`, `logout`).

## Bloque B — Pagos aprobados que no activaron el servicio (hallazgo MEDIO)

**Problema.** En `pagos/pagos.service.ts`, si un pago aprobado llega cuando la sesión ya no está `PENDIENTE` (timeout, cancelación), o el monto es insuficiente, solo se hace `logger.error("revisar manualmente — posible reembolso")`. El dueño no lo ve. Tampoco se valida `currency_id === 'ARS'`, ni se contempla que un pago aprobado pase después a `refunded` / `charged_back` / `cancelled`.

**Qué hacer.**

1. **Modelo** (migración a mano): en `Pago`, agregar `requiereRevision Boolean @default(false)`, `motivoRevision String?`, `resolucion String?` (`VALE_EMITIDO` | `REEMBOLSADO_MANUAL` | `IGNORADO`), `resueltoEn DateTime?`; extender `EstadoPago` con `REEMBOLSADO`. Índice sobre `(requiereRevision, resueltoEn)`.
2. **Marcar los casos:** pago aprobado sin servicio (sesión ya no pendiente, turno vencido, monto menor al esperado, `external_reference` desconocido, moneda distinta de ARS) → registrar el `Pago` con `requiereRevision=true` y el motivo. No perder la plata en silencio.
3. **Estados posteriores:** en `procesarPagoVerificado`, si llega un pago ya registrado como `APROBADO` que ahora figura `refunded`/`charged_back`/`cancelled` en MP → pasar el `Pago` a `REEMBOLSADO` y, si la sesión sigue `ACTIVA`, marcarlo para revisión **sin cortar la corriente automáticamente** (decisión: lo resuelve el dueño desde el panel). Mantener la idempotencia y las condiciones atómicas (`updateMany` condicional) que ya existen.
4. **Admin API:** `GET /admin/pagos/revision` (pendientes de resolver, paginado, con datos de la silla/turno), `POST /admin/pagos/:id/resolver` con `{ accion: 'emitir_vale' | 'marcar_reembolsado' | 'ignorar', nota? }`. `emitir_vale` usa `CreditosService.emitir` con la duración de la silla/turno original y deja el crédito vinculado; todo con DTO validado, `ParseUUIDPipe`, y idempotente (resolver dos veces no emite dos vales).
5. **Panel admin (`/admin`):** sección "Pagos para revisar" con contador/badge visible en el encabezado, lista y botones de acción con confirmación. Coherente con el sistema de diseño aprobado (crema/terracota/salvia, Outfit, sin sombras).
6. La métrica de ingresos del panel (`AdminService.metricas`) no debe contar pagos `REEMBOLSADO`.

**Tests.** Cada caso de "aprobado sin servicio" queda marcado con su motivo; moneda ≠ ARS; monto insuficiente; transición a `REEMBOLSADO` con sesión activa (no corta el relé); idempotencia (mismo webhook dos veces); carrera webhook vs. retorno del navegador sobre el mismo pago (ver bloque E); `resolver` es idempotente y no emite dos vales; métricas excluyen reembolsados; E2E de los endpoints nuevos con y sin token.

## Bloque C — Endpoints públicos sin caché y polling (hallazgo MEDIO)

**Problema.** Cada poll de `/sillas/:id/estado`, `/sesiones/:id/estado`, `/cola/:id/estado` y `/cola/estado` pega a la base. Los hooks del frontend sondean cada 3–5 s (`useEstadoSilla` 5 s, `useEstadoTurno` 3 s, `useEstadoSesion`).

**Qué hacer.**

1. Caché en memoria con TTL corto (1,5 s por defecto, configurable) para esas lecturas, con **coalescing** de requests en vuelo (N requests simultáneas al mismo id comparten una sola consulta). Invalidar explícitamente cuando cambie el estado (cambio de estado de silla, cierre de sesión, asignación de turno) para que el cliente no vea datos viejos tras una acción propia. `segundosRestantes` se calcula al responder, no se cachea congelado.
2. Frontend: los hooks pausan el polling cuando la pestaña no está visible (`document.visibilityState`) y retoman al volver (con una consulta inmediata); ante un 429 respetan `Retry-After` con backoff en vez de reintentar a ritmo fijo. La pantalla TV (`/silla/[id]/pantalla`) **no** debe pausarse.
3. **No** implementar SSE en este prompt (queda como mejora futura); dejalo anotado en el informe.

**Tests.** Cache: hit, expiración, coalescing (N llamadas simultáneas → 1 consulta a Prisma), invalidación al cambiar el estado, no cachea errores/404 por más tiempo del TTL, `segundosRestantes` correcto al leer del caché. Hooks: lógica de pausa/reanudación y backoff extraída a funciones puras y testeadas.

## Bloque D — Hallazgos BAJOS

1. **Paginación:** `take`/`skip` negativos en `GET /admin/sesiones` y `GET /admin/creditos` hoy producen error 500. Validar con DTO/pipes (`@Min(0)`, `take` entre 1 y 200) → 400.
2. **DTOs de silla** (`crear-silla.dto.ts`, `actualizar-silla.dto.ts`): `nombre` con `@MaxLength(60)` y `@Transform` de trim; `precio` con `@Max(1_000_000)` y a lo sumo 2 decimales; `deviceIdShelly` con `@MaxLength(64)` y formato hexadecimal si corresponde a los IDs reales de Shelly (confirmalo con los valores existentes antes de restringir).
3. **CORS:** reemplazar `enableCors({ origin: true })` por una lista desde `CORS_ORIGINS` (separada por comas); en desarrollo permitir localhost; en producción exigirla. Límite explícito de tamaño de body (1 MB).
4. **Código muerto:** borrar `backend/src/pagos/mercadopago.service.ts` (re-export sin uso; el servicio real vive en `src/mercadopago/`) y confirmar con `grep` que nadie lo importa.
5. **Alerta de 0 W** en `HeartbeatService`: verificá que solo se dispare cuando `potenciaW !== null` (el Shelly 1 Gen3 no mide consumo y no debe generar falsas alarmas). Agregar test.
6. **README del backend:** actualizar la máquina de estados (incluye `RESERVADA`, `PAGO_PENDIENTE`, `ESPERANDO_ENERGIA`, cola de turnos), los endpoints nuevos, la tabla de límites vigente, las variables de entorno y cómo correr los tests. Agregar una nota: la alerta "relé ON con 0 W" solo funciona con hardware que mida consumo (1PM).

**Tests.** Paginación negativa → 400; DTOs rechazan nombre largo / precio excesivo / IDs inválidos; CORS permite solo los orígenes configurados; `HeartbeatService` sin `potenciaW` no alerta.

## Bloque E — Tests de la lógica que maneja plata

Hoy no hay ningún test. Cubrí, como mínimo:

1. **`PagosService.procesarPagoVerificado` / `registrarEstadoPago`:** idempotencia (mismo `payment_id` dos veces), pago rechazado que luego se aprueba, monto insuficiente, `external_reference` desconocido, pago de `Sesion` vs. de `Turno`, y la **carrera webhook vs. retorno del navegador** ejecutando ambos con `Promise.all` sobre el mismo pago: solo uno debe aplicar el pago (una sola activación de silla / un solo turno en cola). La carrera real depende de la restricción `UNIQUE(payment_id_mp)` de Postgres, así que esta prueba se hace como **test de integración con una base de datos de test real**: `DATABASE_URL_TEST`, `prisma migrate deploy` antes de la suite, limpieza entre tests, script `npm run test:int`. Si no hay Postgres disponible en tu entorno, decímelo y dejá la suite escrita con las instrucciones para que la corra yo (por ejemplo con `docker run postgres` si tengo Docker); nunca apuntes esos tests a la base de desarrollo.
2. **`EnergiaService`** (`sesiones/energia.service.ts`): corte corto (vuelve dentro de 5 min → compensación + 30 s de gracia, `segundosCompensados`/`cortes`), corte largo (sesión `CANCELADA` con motivo `corte_de_energia` y **un solo** vale), pago con relé caído (`ESPERANDO_ENERGIA`, reintentos, vale tras 10 min), relé huérfano (se apaga tras 60 s), y **dos pasadas superpuestas** (el flag `corriendo` y los `updateMany` condicionales evitan doble vale/doble compensación). Usá timers falsos e inyectá o mockeá el reloj; `ShellyService` y `HeartbeatService` mockeados.
3. **`CreditosService`:** emisión con código único (reintentos ante colisión), `tomar` concurrente, vencimiento, y que el vale se emita **después** del cierre exitoso de la sesión, nunca antes.
4. **`SesionesService`:** máquina de estados (LIBRE → PAGO_PENDIENTE → EN_USO → LIBRE), timeout de 3 min, reconstrucción de timers en `onApplicationBootstrap`, `activarManual` y `detenerEmergencia`. `ColaService`: asignación al turno más antiguo, timeout de 2 min de confirmación, canje de vale respetando `prioridadDesde`.
5. Meta de cobertura orientativa: ≥ 80 % de líneas en `pagos/`, `creditos/` y `sesiones/energia.service.ts`. Reportá la cobertura (`jest --coverage`).

## Bloque F — Prueba de carga

1. Carpeta `loadtest/` en la raíz del repo con un script **k6** (si no podés instalar k6 en tu entorno, usá `autocannon` vía npm y decímelo). Escenarios: (a) 50 usuarios virtuales con polling de estado cada 3–5 s durante 5 minutos, repartidos en 3 IPs simuladas (header `x-client-ip` + secreto de prueba); (b) 5 checkouts por minuto con Turnstile deshabilitado o con la clave de prueba de Cloudflare; (c) pantalla TV sondeando; (d) ráfaga de 200 requests en 10 s desde una sola IP para comprobar que aparece el 429 y que las demás IPs no se ven afectadas.
2. Umbrales: p95 de lectura de estado < 300 ms con el caché; 0 % de errores 5xx; los 429 solo en el escenario (d); conexiones a Postgres estables. Corré contra el entorno local, **nunca** contra Mercado Pago real ni contra la cuenta real de Shelly (mockeá `ShellyService`/MP mediante variables de entorno de prueba o un modo `LOADTEST=true` que solo funcione fuera de producción).
3. Informe con resultados (tabla de p50/p95/p99, tasa de errores, 429 por escenario) y recomendaciones si algo no cumple.

## Criterios de aceptación finales

- [ ] `npx tsc --noEmit`, `npm test`, `npm run test:e2e`, `npm run test:int` (o instrucciones si no pudiste correrlo), `npm run build` en backend y `npm run build` en frontend, en verde.
- [ ] Migraciones nuevas escritas a mano y revisadas (`tokenVersion`, campos de revisión en `Pago`, `REEMBOLSADO`); comando exacto para aplicarlas.
- [ ] Prueba manual documentada: login/logout con cookie (sin `localStorage`), bloqueo por cuenta, un pago aprobado sin servicio que aparece en el panel y se resuelve con un vale, polling pausado con la pestaña oculta.
- [ ] README actualizado y informe de cobertura y de carga entregados.
- [ ] Nada de despliegue, hardware ni decisiones comerciales.
