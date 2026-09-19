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
| `creditos` | Vales por tiempo pagado que no se pudo prestar (cortes de energía) |
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
| GET | `/sillas/:id/estado` | `{ estado, precio, duracionMin, segundosRestantes, sinEnergia }` |
| GET | `/sesiones/:id/estado` | Estado de la sesión propia del cliente: corte en curso, tiempo devuelto, vale emitido |
| POST | `/cola/canjear` | Canjea un vale (`{ codigo }`) y devuelve el turno generado |
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
| GET | `/admin/creditos?take` | Vales emitidos por cortes y si ya se usaron |
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

## Cortes de energía

El servidor está en la nube y el relé en el local: un corte de luz apaga el
hardware sin que el backend se entere. `EnergiaService` (en `sesiones/`) lee
cada 15 s la salud que publica el heartbeat y decide.

| Situación | Qué hace el sistema |
|---|---|
| Se corta la luz con una sesión andando | Marca `interrumpidaEn` y **congela** el reloj: el contador del cliente deja de bajar |
| Vuelve dentro de `UMBRAL_CORTE_SEG` (5 min) | Reenciende el relé y **devuelve el tiempo caído + 30 s** de gracia; el turno sigue |
| El corte pasa los 5 min | Cierra la sesión y emite un **vale** por los minutos que faltaban |
| Entra el pago con el relé sin responder | La sesión queda en `ESPERANDO_ENERGIA` (la plata no se pierde) y se reintenta 10 min; después, vale |
| El cliente quiere pagar con la silla caída | El checkout se rechaza — no se cobra lo que no se puede entregar |
| Vuelve la luz con el relé encendido y sin sesión detrás | Se apaga solo tras 60 s de verlo así |

Decisiones detrás de esto:

- **No se le pregunta nada al cliente durante un corte corto.** Está sentado en
  la silla y la ve apagarse; pedirle una confirmación implicaría depender de
  que tenga la pestaña abierta, y perdería el turno por no contestar.
- **En un corte largo tampoco se pregunta: se emite un vale.** Canjearlo *es*
  la confirmación de que sigue en el local, y funciona igual si se fue y
  vuelve al rato. Vencen a los 7 días (`VIGENCIA_CREDITO_DIAS`).
- **El vale es por los minutos que faltaban**, no por un turno entero, y al
  canjearse entra a la cola con la antigüedad original (`prioridadDesde`): el
  corte no lo manda al final de la fila.
- Un corte a menos de `RESTO_DESPRECIABLE_SEG` (60 s) del final cierra la
  sesión como cumplida y no genera vale.
- La gracia de 30 s no es un regalo arbitrario: cubre el retraso de detección
  del heartbeat y el hecho de que la masajeadora vuelve en standby y hay que
  apretar start de nuevo.

### Configuración obligatoria del Shelly: `initial_state = off`

`switch:0.initial_state` decide qué hace el relé **cuando le vuelve la
corriente**. Los cuatro valores posibles son `off`, `on`, `restore_last` y
`match_input`, y para este sistema tiene que quedar en **`off`**: con
`restore_last` el equipo enciende por su cuenta una silla que a lo mejor ya no
tiene sesión (y que nadie pagó), y con `match_input` el relé le hace caso al
interruptor físico en vez de al backend. El backend tiene que ser el único que
decide encender.

Esto **no se puede cambiar desde el código**: la Cloud Control API v2 solo
permite leer estado y prender/apagar la salida, no tocar la configuración del
equipo. Hay tres formas de hacerlo, en orden de practicidad:

**1. App Shelly Smart Control (la única que anda a distancia).** Es la que
sirve si no estás en el local, porque va por la nube:

```
Abrir el dispositivo → Configuración (⚙) → Output settings / Configuración de salida
   → "Action on power on" / "Acción al encender" → elegir "Turn OFF" / "Apagar"
```

**2. Interfaz web del equipo** (hay que estar en el WiFi del local). Entrar a
`http://<IP-del-Shelly>` y seguir el mismo camino: `Settings → Output Settings
→ Action on power on → Turn OFF`. La IP está en la app, en *Device
information*, o en la lista de DHCP del router.

**3. RPC local, si preferís no depender de la UI** (también desde el WiFi del
local). Es la forma determinística y la que deja constancia de lo que quedó:

```bash
# aplicar
curl -s 'http://<IP>/rpc/Switch.SetConfig?id=0&config=%7B%22initial_state%22%3A%22off%22%7D'

# verificar — tiene que devolver "initial_state":"off"
curl -s 'http://<IP>/rpc/Switch.GetConfig?id=0'
```

La configuración queda guardada en el equipo y sobrevive a reinicios y cortes:
se hace una sola vez por Shelly, cuando el electricista lo instala.

**El sistema lo verifica solo.** Al vincular una silla y en el botón "Probar"
del panel, el backend pide los `settings` del equipo y avisa si
`initial_state` no está en `off` (ver `AdminService.advertirInitialState`). No
bloquea el alta — el equipo funciona igual y `EnergiaService` apaga cualquier
relé encendido sin sesión detrás — pero la advertencia queda a la vista.

### Por qué hay que remandar el ON al reanudar

El `toggle_after` que se programa junto al encendido **vive adentro del
equipo**, así que un corte de luz lo borra: el Shelly rebootea sin ese timer
pendiente. Por eso `reanudarTrasCorte` no alcanza con "prender de nuevo", sino
que manda el ON con `toggle_after` recalculado sobre el tiempo que le queda al
cliente.

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
