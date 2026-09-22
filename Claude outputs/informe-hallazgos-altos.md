# Informe — Hardening de los 4 hallazgos ALTOS

Rama: `hardening/altos`. Nada commiteado (a la espera de que lo pidas). No se tocó ningún `.env`, no se imprimió ningún secreto, y no se tocó nada de despliegue (VPS/Nginx/dominio/Certbot/PM2/backups).

## Hallazgo 1 — Rate limit por IP real

- `frontend/src/lib/resolver-ip-cliente.ts` (nuevo): confía solo en `cf-connecting-ip`.
- `frontend/src/app/api/[...path]/route.ts`: borra todo header de IP spoofeable entrante y reenvía `x-client-ip` + `x-proxy-secret` (`PROXY_SHARED_SECRET`).
- `backend/src/common/client-ip.util.ts` (nuevo): `resolverIpConfiable()` compara el secreto con `timingSafeEqual`; sin match, cae a la IP del socket.
- `backend/src/common/ip-throttler.guard.ts` (nuevo): `IpThrottlerGuard` — tracker real por IP, registrado global (`app.module.ts`).
- `backend/src/common/throttle.config.ts` (nuevo): límites centralizados (240/min global y `/estado`, 6/min checkout, 5/min login, 10/min confirmar/cancelar, 300/min webhook). Se quitó `@SkipThrottle()` del webhook.
- `backend/src/main.ts`: arranca llamando a `verificarEntornoDeArranque()`.

## Hallazgo 2 — Checkout sin pagar

- Cloudflare Turnstile: `backend/src/common/turnstile.service.ts` (nuevo, fail-closed), `turnstileToken` opcional en `CheckoutDto`/`UnirseColaDto`, widget `frontend/src/components/TurnstileWidget.tsx`.
- `ip_hash` en `Sesion`/`Turno`: `backend/src/common/ip-hash.service.ts` (HMAC-SHA256, nunca IP en claro) + migración a mano `backend/prisma/migrations/20260921230000_ip_hash_pendientes/` + índice `(ip_hash, estado)`.
- Tope de reservas pendientes por IP: `backend/src/common/reservas-pendientes.util.ts`, `MAX_PENDIENTES_POR_IP` (default 3) → 429.
- `PagosService.iniciarCheckout` y `ColaService.unirse` ahora verifican Turnstile y el tope antes de reservar.

## Hallazgo 3 — Vales adivinables

- `backend/src/creditos/codigo-credito.util.ts`: `crypto.randomInt`, alfabeto sin ambigüedades, formato nuevo `LUZ-XXXX-XXXX` (8.5×10¹¹ combinaciones vs. 10.000 antes). `normalizarCodigo()` sigue aceptando el formato viejo `LUZ-1234` para vales ya emitidos.
- `backend/src/cola/codigo.util.ts`: mismo cambio `Math.random` → `crypto.randomInt` para el código de turno.
- `backend/src/creditos/creditos.service.ts`: `tomar()` reescrito como un solo `updateMany` condicional — inexistente, usado y vencido devuelven exactamente la misma excepción, mismo mensaje, mismo camino (nada medible por tiempo). El detalle real se loguea aparte, sin el código completo (solo un prefijo de 4 caracteres).
- `backend/src/creditos/fallos-canje.service.ts` (nuevo): bloquea una IP 1h tras 20 fallos de canje en 1h; un éxito limpia el historial. Wireado en `ColaService.canjearCredito`/`ColaController.canjear`.
- Frontend: `FormCodigoCredito.tsx` y `TarjetaCredito.tsx` actualizados (placeholder/maxLength del formato nuevo, mensaje específico para 429).

## Hallazgo 4 — Webhook fallaba abierto + log de debug

- `backend/src/mercadopago/mercadopago.service.ts`: `validarFirma()` ahora falla **cerrado** por defecto sin `MP_WEBHOOK_SECRET` (antes aceptaba todo). Única excepción: `MP_WEBHOOK_ALLOW_UNSIGNED=true` fuera de producción, con warning fuerte en el log.
- Se sacó el log de debug que imprimía el HMAC esperado, el recibido y el largo del secreto; ahora solo loguea `data.id` y `x-request-id` en un mismatch.
- Parsing de `x-signature` endurecido: rechaza (sin tirar excepción) formato sin `=`, campos vacíos, claves duplicadas y `v1` que no sea hex de 64 caracteres. No hay ventana de tiempo sobre `ts` (MP reintenta horas).
- `verificarEntornoDeArranque()` extendida: producción sin `MP_WEBHOOK_SECRET` aborta el arranque, sin excepción posible (ni con `MP_WEBHOOK_ALLOW_UNSIGNED`).

## Tests agregados

Infra nueva: Jest+ts-jest+supertest en el backend (`npm test`, `npm run test:e2e`), Vitest mínimo en el frontend (`npm test`).

- **81 tests unitarios** backend (11 suites): `client-ip.util`, `verificar-entorno` (13 casos, los 4 secretos), `ip-hash.service`, `turnstile.service`, `reservas-pendientes.util`, `codigo-credito.util` (formato/alfabeto/no-Math.random/10.000 sin colisión/distribución), `normalizarCodigo`, `creditos.service.tomar` (excepción uniforme para los 3 casos de fallo + canje concurrente vía `Promise.all`), `fallos-canje.service` (con fake timers: bloqueo a los 20, expira a la 1h, IPs independientes, éxito limpia), `pagos.service`/`cola.service` (Turnstile + tope + canje), `mercadopago.service.validarFirma` (firma válida/inválida, 9 casos de parsing malformado, comportamiento sin secreto, y que nunca loguea el HMAC/secreto).
- **8 tests e2e** (3 suites, `TestingModule` + supertest, sin DB real — Prisma mockeado): rate limit por IP con secreto (independiente por IP, no evadible sin secreto, 429 en el 6º intento de login), 21º intento de canje fallido → 429 sin tocar Prisma de nuevo, webhook (sin firma → 403, firma inválida → 403, firma válida → procesa, IPN vieja → passthrough sin exigir firma).
- **5 tests** frontend (Vitest) para `resolverIpCliente`.

## Resultado de cada comando

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` (backend) | ⚠️ **4 errores**, todos `TS2353 ... 'ipHash' does not exist` en `cola.service.ts`, `reservas-pendientes.util.ts` (x2), `sesiones.service.ts` — el cliente de Prisma no se pudo regenerar en este entorno (ver abajo). Ningún otro error. |
| `npm test` (backend) | ✅ **81/81 pasando** |
| `npm run test:e2e` (backend) | ✅ **8/8 pasando** |
| `npm run build` (backend, `nest build`) | ❌ **Falla** — los mismos 4 errores de arriba (usa `tsc`) |
| `npx tsc --noEmit` (frontend) | ✅ limpio |
| `npm test` (frontend, Vitest) | ✅ **5/5 pasando** |
| `npm run build` (frontend, `next build`) | ⚠️ **No se pudo verificar** — ver abajo |

## Lo que NO pude verificar (y qué correr vos)

1. **`npx prisma generate` / `npx prisma migrate dev`** — este entorno no tiene salida de red hacia `binaries.prisma.sh` (403 Forbidden), así que no pude regenerar el cliente de Prisma ni aplicar la migración. Los 4 errores de `tsc`/build de arriba son consecuencia directa de esto (el campo `ipHash` no existe todavía en los tipos generados) — no hay ningún otro problema de tipos en el código nuevo, ya lo aislé y confirmé. Corré esto vos, donde sí haya red:
   ```bash
   cd backend
   npx prisma generate
   npx prisma migrate dev      # desarrollo
   # npx prisma migrate deploy  # producción
   ```
   La migración ya está escrita a mano en `backend/prisma/migrations/20260921230000_ip_hash_pendientes/migration.sql` (agrega `ip_hash` a `sesiones` y `turnos` + índice compuesto con `estado`) — dale una revisada antes de aplicarla.

2. **`npm run build` del frontend (`next build`)** — no por restricción de red esta vez, sino porque el build no terminó dentro del límite de tiempo por comando de esta sandbox (170-180s), y no hay forma de dejarlo corriendo en background entre llamadas en este entorno. `npx tsc --noEmit` sí corrió limpio y Vitest pasa, así que el tipado y la lógica nueva están verificados, pero el build de producción de Next en sí no. Corré vos:
   ```bash
   cd frontend
   npm run build
   ```

No marqué ninguna de estas dos cosas como verificada.

## Pruebas manuales (quedaron documentadas en `backend/README.md`)

Agregué al README los `curl` de: rate limit con 2 `x-client-ip` distintos, 21 intentos de canje fallido desde la misma IP, y webhook sin firma → 403. También agregué una tabla con las 5 variables de entorno nuevas (qué pasa si faltan en dev vs. producción) y la tabla completa de límites de rate limiting actuales.

## Fuera de alcance (a propósito)

No toqué nada de los hallazgos medio/bajo del segundo prompt — lo dejé intacto para cuando me lo pases.
