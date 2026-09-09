# Backend — Sistema Autoservicio de Sillas Masajeadoras

Nest.js + Prisma + PostgreSQL. Pagos con Mercado Pago Checkout Pro, control de hardware vía [Shelly Cloud Control API v2](https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2).

## Setup

```bash
cd backend
npm install
cp .env.example .env   # completar credenciales
npm run prisma:migrate  # crea las tablas
npm run seed            # crea usuario admin + silla de ejemplo
npm run start:dev
```

## Estructura de módulos

| Módulo | Responsabilidad |
|---|---|
| `sillas` | Estado público de cada silla (landing y pantalla TV) |
| `pagos` | Preferencias de MP, webhook con firma HMAC + verificación contra API, idempotencia |
| `sesiones` | Máquina de estados y timers (único módulo que transiciona estados) |
| `shelly` | Relé ON/OFF vía Shelly Cloud Control API v2 + heartbeat cada 30s |
| `admin` | Login JWT, historial, métricas, activación manual, parada de emergencia |
| `prisma` | Acceso a datos (global) |

## Máquina de estados

```
LIBRE → PAGO_PENDIENTE → EN_USO → LIBRE
         (timeout 3min)   (timeout duracionMin)
```

Al reiniciar el servidor, `SesionesService.onApplicationBootstrap()` reconstruye los timers desde la DB. Como fallback, el comando de encendido programa el **auto-off en la propia nube de Shelly** (`toggle_after` = duración + 1 min, ver `MARGEN_AUTO_OFF_SEG`): aunque el backend no llegue a mandar el OFF, el relé se corta solo. Ya no hace falta configurarlo a mano en el dispositivo.

## Endpoints

### Públicos

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/sillas/:id/estado` | `{ estado, precio, duracionMin, segundosRestantes }` |
| POST | `/sillas/:id/checkout` | Reserva la silla y devuelve `{ sesionId, initPoint }` (URL de Checkout Pro) |
| POST | `/sillas/:id/confirmar-pago` | Respaldo del retorno de Checkout Pro; verifica el pago contra MP |
| POST | `/webhooks/mercadopago` | Webhook de MP (firma HMAC validada) |

### Admin (Bearer JWT)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/admin/auth/login` | `{ email, password }` → `{ token }` (rate limit 5/min) |
| GET | `/admin/sillas` | Estado en vivo + salud del hardware |
| GET | `/admin/sesiones?take&skip` | Historial paginado |
| GET | `/admin/metricas` | Sesiones e ingresos (hoy / 30 días) |
| GET | `/admin/salud` | Último heartbeat de cada Shelly |
| GET | `/admin/shelly/dispositivos/:deviceId` | Verifica un device contra la nube (existe / online / modelo) |
| PATCH | `/admin/sillas/:id` | Editar nombre / precio / duración |
| POST | `/admin/sillas/:id/activar` | Activación manual (sin pago) |
| POST | `/admin/sillas/:id/detener` | Parada de emergencia |
| GET | `/admin/sillas/:id/probar` | Estado en vivo del Shelly de esa silla |

## Reglas críticas implementadas

- El webhook **nunca confía en el body**: consulta `GET /v1/payments/{id}` con el Access Token.
- Firma `x-signature` validada con HMAC-SHA256 (`MP_WEBHOOK_SECRET`).
- La URL del Webhook se configura en **Tus integraciones**; las preferencias no la sobreescriben.
- Si el Webhook demora o no llega, el back_url reconcilia el `payment_id` contra la API de MP.
- Idempotencia: `payment_id_mp` es UNIQUE; webhooks duplicados se ignoran.
- Race condition: la reserva usa `updateMany({ where: { estado: LIBRE } })` — dos clientes no pueden reservar a la vez.
- La preferencia de MP expira a los 3 min (misma ventana que la reserva).
- Si el relé falla al encender, el pago queda registrado y el admin puede activar manualmente.

## Integración con Shelly Cloud

Se usa la **Cloud Control API v2** (`ShellyService`). Los endpoints viejos
(`/device/status`, `/device/relay/control`, `/device/all_status`) están marcados
como deprecados por Shelly y ya no se usan.

| Uso | Request |
|---|---|
| Estado | `POST {SHELLY_SERVER}/v2/devices/api/get?auth_key=…` con `{ ids: [...], select: ["status","settings"] }` |
| Relé | `POST {SHELLY_SERVER}/v2/devices/api/set/switch?auth_key=…` con `{ id, channel: 0, on, toggle_after? }` |

Diferencias a tener en cuenta:

- **Éxito = HTTP 200 sin campo `error`** (la v1 usaba `isok`). Los errores vienen
  como `{ "error": "DEVICE_OFFLINE", "data": { "messages": [...] } }`; `ShellyService`
  los traduce a mensajes en castellano (ver `ERRORES_V2`).
- **No existe `all_status`**: hay que pasar la lista de device ids, máximo 10 por
  request. `listarDispositivos()` sin argumentos toma los ids de la tabla `sillas`
  y trocea en lotes; el heartbeat usa eso. Un id que no está en la cuenta **se
  omite de la respuesta** (no da error ni rompe el lote), así que el heartbeat lo
  detecta por ausencia.
- **`select`**: el heartbeat pide solo `["status"]`. Los `settings` son varios KB
  por equipo (config completa, incluida una key del dispositivo) y solo se piden
  en el alta de sillas, que es donde hace falta la generación real.
- **El `gen` del envoltorio no es la generación del equipo**: identifica la familia
  de protocolo, así que un Shelly 1 **Gen3** se reporta como `"G2"`. La generación
  real está en `settings.DeviceInfo.gen`.
- **Alta de sillas**: sin `all_status` no se puede ofrecer un desplegable con los
  equipos de la cuenta. El admin ingresa el device ID (está en la app Shelly, en
  *Device info*, y en la etiqueta del equipo) y lo valida con
  `GET /admin/shelly/dispositivos/:deviceId`.
- **Rate limit: 1 request/segundo por cuenta.** Todas las llamadas pasan por una
  cola con espaciado de 1100 ms, y el estado de las sillas se cachea 15 s.
- La `auth_key` **cambia si se cambia la contraseña** de la cuenta Shelly.

## Monitoreo del hardware

El heartbeat corre cada 30 s y levanta estas alertas por silla (se ven en
`GET /admin/salud` y embebidas en `GET /admin/sillas`):

| Alerta | Requiere |
|---|---|
| Device ID no encontrado en la cuenta | — |
| Dispositivo Shelly sin conexión | — |
| Relé encendido sin sesión activa | — |
| Relé a N °C: revisar ventilación | `switch:0.temperature.tC` (lo trae Plus 1, 1 Gen3 y 1PM). Umbral: `TEMP_ALERTA_C` |
| Relé encendido pero consumo 0W | `switch:0.apower` — **solo modelos con medición (1PM)** |

## Nota de hardware

La alerta "relé ON con 0W" requiere medición de potencia: ni el **Shelly Plus 1** ni el **Shelly 1 Gen3** miden consumo — en su `switch:0` directamente no existe el campo `apower` (el **1PM** sí lo trae). Con Plus 1, el heartbeat igualmente detecta dispositivo offline y relé encendido sin sesión. Si quieren la detección de silla desenchufada, comprar **Plus 1PM** (diferencia de precio menor).
