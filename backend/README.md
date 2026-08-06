# Backend — Sistema Autoservicio de Sillas Masajeadoras

Nest.js + Prisma + PostgreSQL. Pagos con Mercado Pago Checkout Pro, control de hardware vía Shelly Cloud API.

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
| `shelly` | Relé ON/OFF vía Shelly Cloud API + heartbeat cada 30s |
| `admin` | Login JWT, historial, métricas, activación manual, parada de emergencia |
| `prisma` | Acceso a datos (global) |

## Máquina de estados

```
LIBRE → PAGO_PENDIENTE → EN_USO → LIBRE
         (timeout 3min)   (timeout duracionMin)
```

Al reiniciar el servidor, `SesionesService.onApplicationBootstrap()` reconstruye los timers desde la DB. El Shelly debe tener **auto-off** configurado (duración + 1 min) como fallback.

## Endpoints

### Públicos

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/sillas/:id/estado` | `{ estado, precio, duracionMin, segundosRestantes }` |
| POST | `/sillas/:id/checkout` | Reserva la silla y devuelve `{ sesionId, initPoint }` (URL de Checkout Pro) |
| POST | `/webhooks/mercadopago` | Webhook de MP (firma HMAC validada) |

### Admin (Bearer JWT)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/admin/auth/login` | `{ email, password }` → `{ token }` (rate limit 5/min) |
| GET | `/admin/sillas` | Estado en vivo + salud del hardware |
| GET | `/admin/sesiones?take&skip` | Historial paginado |
| GET | `/admin/metricas` | Sesiones e ingresos (hoy / 30 días) |
| GET | `/admin/salud` | Último heartbeat de cada Shelly |
| PATCH | `/admin/sillas/:id` | Editar nombre / precio / duración |
| POST | `/admin/sillas/:id/activar` | Activación manual (sin pago) |
| POST | `/admin/sillas/:id/detener` | Parada de emergencia |

## Reglas críticas implementadas

- El webhook **nunca confía en el body**: consulta `GET /v1/payments/{id}` con el Access Token.
- Firma `x-signature` validada con HMAC-SHA256 (`MP_WEBHOOK_SECRET`).
- Idempotencia: `payment_id_mp` es UNIQUE; webhooks duplicados se ignoran.
- Race condition: la reserva usa `updateMany({ where: { estado: LIBRE } })` — dos clientes no pueden reservar a la vez.
- La preferencia de MP expira a los 3 min (misma ventana que la reserva).
- Si el relé falla al encender, el pago queda registrado y el admin puede activar manualmente.

## Nota de hardware

La alerta "relé ON con 0W" requiere medición de potencia: el **Shelly Plus 1 no mide consumo** (el Plus 1PM sí). Con Plus 1, el heartbeat igualmente detecta dispositivo offline y relé encendido sin sesión. Si quieren la detección de silla desenchufada, comprar **Plus 1PM** (diferencia de precio menor).
