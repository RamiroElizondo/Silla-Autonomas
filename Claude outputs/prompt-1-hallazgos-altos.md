# PROMPT 1 — Endurecimiento de seguridad: los 4 hallazgos ALTOS

Copiá todo lo que sigue en un chat nuevo, con la carpeta `Silla-Autonomas` conectada.

---

## Contexto

Trabajás sobre el repo `Silla-Autonomas` (backend Nest.js 10 + Prisma 5 + PostgreSQL en `backend/`, frontend Next.js en `frontend/`). Es un sistema de autoservicio de sillas masajeadoras: el cliente paga con Mercado Pago Checkout Pro, el backend valida el pago y enciende un relé Shelly por la Cloud Control API v2. Hay pago directo a una silla (`Sesion`), cola compartida (`Turno`), y vales por cortes de energía (`Credito`, código `LUZ-1234`). El navegador nunca le pega directo al backend: todo pasa por el proxy `frontend/src/app/api/[...path]/route.ts`, que reenvía al backend por `BACKEND_INTERNAL_URL`.

Una auditoría previa encontró 4 hallazgos de gravedad ALTA. Tu trabajo es corregir **solo esos 4**, con tests. Hay un segundo prompt aparte para el resto de los hallazgos: no lo adelantes.

**Fuera de alcance:** cualquier cosa de despliegue (VPS, Nginx, dominio, Certbot, PM2, backups). No toques `.env` ni imprimas secretos. No hagas commit sin que yo lo pida. El trabajo previo (Shelly v2, cortes de energía, créditos, cola) ya está commiteado: partí de ese estado.

## Reglas de trabajo

1. Antes de escribir código, leé los archivos que menciono y armá un plan corto; mostrámelo y esperá mi OK.
2. Todo cambio de comportamiento lleva test. No des nada por terminado si no corren: `npx tsc --noEmit` (backend), `npm test` (backend, lo creás en el paso 1) y `npm run build` en backend y frontend.
3. Si tu entorno no puede correr algo (por ejemplo `prisma generate/migrate` o el build de Next por restricciones de red), decímelo explícitamente y listame el comando exacto que tengo que correr yo. No lo marques como verificado.
4. Trabajá en una rama `hardening/altos`.
5. Al final, entregá un informe: qué cambiaste (archivos), qué tests agregaste, resultado de cada comando, y qué quedó sin verificar.

## Paso 1 — Infraestructura de tests (no existe ninguna)

El backend no tiene tests ni runner. Configurá:

- Jest + ts-jest + `@nestjs/testing` + `supertest` (+ tipos). Scripts `test` (unitarios) y `test:e2e` (los que levantan un módulo Nest con supertest, sin base de datos: mockeá `PrismaService`).
- Para el frontend, lo mínimo que necesites para testear lógica pura (Vitest o el runner de Node). Solo si un cambio de este prompt lo requiere.
- Verificá que `npm test` corre con un test trivial antes de seguir.

## Hallazgo 1 — El rate limit por IP no distingue clientes

**Problema.** Todo llega al backend desde `127.0.0.1` a través del proxy de Next. `app.module.ts` usa `ThrottlerModule` con `ThrottlerGuard` global (30 req / 10 s) y hay `@Throttle` por endpoint, pero el backend no tiene `trust proxy` ni lee `X-Forwarded-For`/`CF-Connecting-IP` (no hay ninguna referencia en el código). Resultado: **todos los clientes comparten el mismo contador**. Consecuencias: con ~10-15 celulares con la página abierta (polling cada 3–5 s) hay 429 para todos; el 6.º checkout del minuto es rechazado; cualquiera bloquea el login del dueño con 5 intentos. Además el proxy copia todos los headers del cliente (`new Headers(request.headers)`), así que si solo se activara `trust proxy` el header sería falsificable.

**Qué hacer.**

1. En el proxy (`route.ts`): leer la IP real del cliente desde `cf-connecting-ip` (Cloudflare la pisa, no la controla el cliente) y, si no existe, de la IP del socket / primer valor confiable. **Borrar** de los headers reenviados: `x-forwarded-for`, `x-real-ip`, `forwarded`, `cf-connecting-ip`, `x-client-ip`. Reenviar la IP calculada en un header propio `x-client-ip` y agregar `x-proxy-secret` con el valor de la variable de entorno `PROXY_SHARED_SECRET`. Extraé la lógica de resolver la IP a una función pura (`resolverIpCliente(headers)`) para poder testearla.
2. En el backend: un `ThrottlerGuard` propio que sobreescriba `getTracker(req)`: usa `x-client-ip` **solo si** `x-proxy-secret` coincide (comparación con `timingSafeEqual`) con `PROXY_SHARED_SECRET`; si no coincide o falta, usa `req.socket.remoteAddress`. Nunca `req.ip` ni `X-Forwarded-For` crudo.
3. Agregar `PROXY_SHARED_SECRET` a `backend/.env.example` y a `frontend/.env.local.example` con comentario. Si falta en producción (`NODE_ENV=production`), el backend debe **fallar al arrancar**; en desarrollo, avisar con un warning y caer al socket.
4. **Importante — el WiFi del local comparte IP.** Los clientes que están dentro del local salen todos por la misma IP pública. Por eso los límites por IP no pueden ser tan bajos como para bloquear clientes legítimos simultáneos. Nuevos límites (definilos como constantes en un solo archivo `throttle.config.ts`, con nombre y comentario de por qué):
   - Global por defecto: 240 / min por IP.
   - GET de estados (`/sillas/:id/estado`, `/sesiones/:id/estado`, `/cola/estado`, `/cola/:id/estado`): 240 / min por IP.
   - `POST` de checkout (silla y cola): 6 / min por IP.
   - `POST /cola/canjear`: ver hallazgo 3.
   - `POST /admin/auth/login`: 5 / min por IP (el bloqueo por cuenta es del segundo prompt).
   - `confirmar-pago`, `cancelar`, `cancelar-pago`, `confirmar`: 10 / min por IP.
   - `POST /webhooks/mercadopago`: reemplazar `@SkipThrottle()` por un límite alto, 300 / min por IP (la firma se valida antes de tocar la base).
5. Asegurate de que el Throttler use storage en memoria (una sola instancia) y dejá un comentario indicando que con varias instancias habría que pasar a Redis.

**Tests obligatorios.**

- Unitario de `resolverIpCliente`: prioriza `cf-connecting-ip`; ignora un `x-forwarded-for` falsificado por el cliente; entrada vacía; IPv6.
- Unitario del `getTracker`: con secreto correcto usa `x-client-ip`; con secreto incorrecto o ausente ignora el header y usa el socket; comparación en tiempo constante.
- E2E (Nest + supertest, Prisma mockeado): dos `x-client-ip` distintos con secreto válido tienen contadores **independientes** (uno llega a 429 y el otro sigue en 200); mismo `x-client-ip` sin secreto válido **no** permite evadir el límite cambiando el header; login llega a 429 en el 6.º intento por IP.
- Unitario del test de arranque: sin `PROXY_SHARED_SECRET` en producción, falla.

## Hallazgo 2 — Se puede bloquear una silla sin pagar

**Problema.** `POST /sillas/:id/checkout` (`PagosService.iniciarCheckout` → `SesionesService.crearSesionPendiente`) pasa la silla a `PAGO_PENDIENTE` 3 minutos sin que se haya pagado nada. Un script lo repite y deja la silla inservible. `POST /cola/checkout` (`ColaService.unirse`) crea turnos `ESPERANDO_PAGO` de la misma manera.

**Qué hacer.**

1. **Cloudflare Turnstile** en el botón de pagar (landing `/silla/[id]` y el flujo de cola):
   - Componente React en el frontend que carga el widget y expone el token; el botón de pagar queda deshabilitado hasta tener token. Diseño coherente con el sistema aprobado (paleta cálida, Outfit).
   - `iniciarCheckout` y `unirseCola` de `frontend/src/lib/api.ts` envían `turnstileToken` en el body; agregarlo a `CheckoutDto` y `UnirseColaDto` (`@IsOptional() @IsString() @MaxLength(2048)`).
   - `TurnstileService` en el backend: verifica contra `https://challenges.cloudflare.com/turnstile/v0/siteverify` con `TURNSTILE_SECRET_KEY` (pasando la IP real). **Falla cerrada** cuando está habilitado: sin token o verificación fallida → 400/403 y sin efectos (no se reserva la silla). Si `TURNSTILE_SECRET_KEY` no está definida, queda deshabilitado con un warning al arrancar (para desarrollo); en producción (`NODE_ENV=production`) exigirla. La verificación se hace **antes** de reservar la silla.
   - Variables: `TURNSTILE_SECRET_KEY` (backend), `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (frontend). Documentar en los `.example`. Para pruebas manuales, indicá las claves de prueba oficiales de Cloudflare (`1x00000000000000000000AA` siempre pasa, `2x0000000000000000000000AB` siempre falla).
2. **Tope de reservas pendientes por IP.** Agregar columna `ip_hash` (nullable) a `Sesion` y `Turno`: hash HMAC-SHA256 de la IP con un secreto del entorno (no guardar la IP en claro). Antes de crear una sesión/turno pendiente, contar los que estén en `PENDIENTE` / `ESPERANDO_PAGO` con ese `ip_hash`; si superan `MAX_PENDIENTES_POR_IP` (constante configurable, por defecto 3, porque el WiFi del local comparte IP y hay más de una silla) responder 429 con mensaje claro. Migración escrita a mano en `prisma/migrations/` (mismo estilo que las existentes) e índice sobre `(ip_hash, estado)`.
3. Reducir el daño residual: si una sesión pendiente se cancela por `cancelar-pago`, debe liberar la silla al instante (ya existe; verificá que siga andando).

**Tests obligatorios.**

- `TurnstileService` con `fetch` mockeado: token válido, inválido, error de red (falla cerrada), servicio deshabilitado (dev) y producción sin clave (falla al arrancar).
- `iniciarCheckout` **no** llama a `crearSesionPendiente` ni a Mercado Pago si Turnstile falla.
- Tope por IP: la 4.ª reserva pendiente desde el mismo `ip_hash` es rechazada; IPs distintas no se afectan; al expirar/cancelar una pendiente se libera cupo.
- La IP hasheada no es reversible ni aparece en claro en la base ni en logs.

## Hallazgo 3 — Los vales (`LUZ-1234`) se pueden adivinar

**Problema.** `creditos/codigo-credito.util.ts` genera `LUZ-` + 4 dígitos con `Math.random()` (10.000 combinaciones), vencen a los 7 días, y `POST /cola/canjear` (`CreditosService.tomar`) responde distinto para inexistente (404), ya usado (409) y vencido (409): eso le confirma al atacante qué códigos existen. Cada vale válido equivale a una sesión gratis.

**Qué hacer.**

1. `generarCodigoCredito()` con `crypto.randomInt`, **8 caracteres** de un alfabeto sin ambigüedades (sin `0/O`, `1/I/L`, etc.), mostrados como `LUZ-XXXX-XXXX`. Que `normalizarCodigo()` siga aceptando minúsculas, espacios y guiones olvidados, **y** que los vales viejos de formato `LUZ-1234` que ya estén en la base sigan siendo canjeables (compatibilidad hacia atrás, con test).
2. Respuesta **uniforme**: inexistente, usado y vencido devuelven el mismo error (mismo status y mismo mensaje, por ejemplo 404 "Código inválido o ya utilizado") y tiempos comparables (no hacer trabajo extra solo en un caso). El detalle real se loguea internamente sin el código completo.
3. **Bloqueo por fallos:** servicio `FallosCanjeService` (en memoria con TTL, una sola instancia) que cuente intentos fallidos por IP real; tras `MAX_FALLOS_CANJE` (20) en 1 hora, bloquear canjes desde esa IP durante 1 hora respondiendo 429 sin siquiera consultar la base. Un canje exitoso no suma. Constantes en `throttle.config.ts`. Mantener el `@Throttle` de 5/min de `canjear`.
4. Mismo cambio de generador para `cola/codigo.util.ts` (`Math.random` → `crypto.randomInt`); ahí el código de turno es solo para mostrar, pero no debe usar `Math.random`.
5. Frontend: `FormCodigoCredito.tsx` y `TarjetaCredito.tsx` deben aceptar y mostrar el formato nuevo (`maxLength`, placeholder, autocapitalizar, mensaje de error uniforme y de bloqueo 429 entendible).

**Tests obligatorios.**

- Generador: formato y longitud; solo caracteres del alfabeto; sin `Math.random` (mockeá `crypto.randomInt` y verificá que se usa); 10.000 códigos sin colisiones evidentes; distribución razonable.
- `normalizarCodigo`: minúsculas, espacios, guiones, formato viejo y nuevo.
- `tomar`: inexistente / usado / vencido devuelven la **misma** excepción; canje válido marca `CANJEADO`; doble canje simultáneo (`Promise.all`) genera un solo turno (la condición del `updateMany`).
- `FallosCanjeService` con timers falsos: 20 fallos → bloqueo; el bloqueo expira a la hora; IPs independientes; canje exitoso no suma.
- E2E: 21 intentos fallidos desde la misma IP → el 21.º responde 429 y no toca el mock de Prisma.

## Hallazgo 4 — El webhook falla "abierto" y hay un log de depuración

**Problema.** En `mercadopago/mercadopago.service.ts`, `validarFirma` devuelve `true` si `MP_WEBHOOK_SECRET` está vacío. Además, cuando la firma no coincide, loguea el HMAC esperado completo y la longitud del secreto (`// DEBUG temporal — sacar`).

**Qué hacer.**

1. Falla cerrada: si falta `MP_WEBHOOK_SECRET`, `validarFirma` devuelve `false`. Única excepción: `MP_WEBHOOK_ALLOW_UNSIGNED=true` **y** `NODE_ENV !== 'production'`, con un warning fuerte al arrancar. En producción sin secreto, abortar el arranque (`onModuleInit`).
2. Eliminar el log de depuración: si la firma no coincide, loguear solo `data.id` y `x-request-id` (nunca el manifest, el HMAC esperado ni el secreto).
3. Endurecer el parseo de `x-signature`: rechazar (no lanzar excepción) valores mal formados, `ts`/`v1` duplicados o vacíos, y `v1` que no sea hexadecimal de 64 caracteres. **No** agregar ventana de tiempo sobre `ts`: Mercado Pago reintenta notificaciones durante horas y eso rechazaría reintentos legítimos.
4. Confirmar (y dejar con test) que el webhook sigue consultando el pago real a la API de MP y que la firma se valida **antes** de cualquier acceso a base de datos.

**Tests obligatorios.**

- Firma válida generada en el test con el mismo algoritmo (`id:...;request-id:...;ts:...;`) → true.
- Sin secreto → false (y en producción, el módulo no arranca); con `MP_WEBHOOK_ALLOW_UNSIGNED=true` fuera de producción → true; con la bandera en producción → falla el arranque.
- Header ausente, mal formado, con `v1` corto, no hexa, campos duplicados, manifest alterado (otro `data.id`) → false, sin excepciones.
- El logger no contiene el HMAC esperado ni el secreto (espía sobre `Logger`).
- E2E del controller: firma inválida → 403 y `PagosService` **no** es invocado; firma válida → 200 y se invoca; IPN viejo (`topic` sin `type`) → 200 ignorado.

## Criterios de aceptación finales

- [ ] `npx tsc --noEmit`, `npm test`, `npm run test:e2e`, `npm run build` (backend) y `npm run build` (frontend) en verde, o listados los que no pudiste correr.
- [ ] Prueba manual documentada (comandos `curl` en el informe): 30+ requests desde dos `x-client-ip` distintos con el secreto → contadores independientes; sin secreto no se puede falsificar; 21 canjes fallidos → 429; webhook sin firma → 403.
- [ ] Migración nueva escrita y revisada; decime el comando exacto para aplicarla (`npx prisma migrate dev` / `deploy`).
- [ ] `backend/README.md` con las variables nuevas (`PROXY_SHARED_SECRET`, `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `MP_WEBHOOK_ALLOW_UNSIGNED`, secreto del hash de IP) y la tabla de límites vigente.
- [ ] Nada de despliegue ni de los hallazgos de gravedad media/baja.
