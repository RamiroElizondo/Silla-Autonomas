/**
 * Límites de rate limiting por IP real (Hallazgo ALTO 1 de la auditoría).
 *
 * Ojo con el contexto: el WiFi del local es compartido por todos los
 * clientes presentes (varias sillas, varios celulares), así que ningún
 * límite puede ser tan bajo que un puñado de clientes legítimos usando
 * sillas distintas al mismo tiempo se bloqueen entre sí. Por eso los
 * números acá son más generosos que un límite "por persona" ingenuo.
 *
 * Todos se miden por IP real (ver `resolverIpConfiable`), nunca por IP del
 * proxy ni globalmente.
 */

interface LimiteThrottle {
  ttl: number;
  limit: number;
}

/** Límite global por defecto (ThrottlerModule.forRoot): cualquier endpoint
 * sin un @Throttle propio. */
export const LIMITE_GLOBAL: LimiteThrottle = { ttl: 60_000, limit: 240 };

/** GETs de estado (silla, sesión, turno, cola): es tráfico de polling, no
 * de escritura — mismo motivo que el global, separado para poder ajustarlo
 * sin tocar el resto. */
export const LIMITE_ESTADO: LimiteThrottle = { ttl: 60_000, limit: 240 };

/** POST de checkout (silla directa y cola): crea una reserva temporal
 * (PAGO_PENDIENTE / ESPERANDO_PAGO). Bajo, pero no tanto como para bloquear
 * a varios clientes del mismo WiFi pagando casi en simultáneo. */
export const LIMITE_CHECKOUT: LimiteThrottle = { ttl: 60_000, limit: 6 };

/** Login del panel admin: un solo usuario, no hace falta más que esto por
 * IP (el bloqueo por cuenta tras fallos repetidos es un hallazgo aparte). */
export const LIMITE_LOGIN: LimiteThrottle = { ttl: 60_000, limit: 5 };

/** confirmar-pago / cancelar-pago / cancelar / confirmar: respaldo del
 * retorno de Checkout Pro y cancelaciones — no necesita ser laxo. */
export const LIMITE_CONFIRMACION: LimiteThrottle = { ttl: 60_000, limit: 10 };

/** Webhook de Mercado Pago: la firma se valida ANTES de tocar la base, así
 * que un límite alto acá es seguro y evita perder reintentos legítimos de
 * MP si manda varias notificaciones seguidas. */
export const LIMITE_WEBHOOK: LimiteThrottle = { ttl: 60_000, limit: 300 };

/** Canje de vales (Hallazgo ALTO 3): límite de intentos por minuto vía
 * @Throttle. El bloqueo por fallas repetidas es un mecanismo aparte
 * (FallosCanjeService, más abajo en este archivo). */
export const LIMITE_CANJEAR: LimiteThrottle = { ttl: 60_000, limit: 5 };

/**
 * Tope de reservas pendientes por IP (Hallazgo ALTO 2): cuántas
 * sesiones/turnos en estado PENDIENTE/ESPERANDO_PAGO se toleran desde el
 * mismo `ip_hash` antes de responder 429. Configurable por env porque es el
 * número más sensible al contexto real del local (cuántas sillas hay);
 * default bajo pero no en 1, porque el WiFi es compartido.
 */
export const MAX_PENDIENTES_POR_IP = Number(
  process.env.MAX_PENDIENTES_POR_IP ?? 3,
);

/** Bloqueo de canjes de vales tras fallos repetidos (Hallazgo ALTO 3). */
export const MAX_FALLOS_CANJE = 20;
export const VENTANA_FALLOS_CANJE_MS = 60 * 60_000; // 1 hora
export const BLOQUEO_CANJE_MS = 60 * 60_000; // 1 hora

// El storage del Throttler (@nestjs/throttler) es el que trae por defecto:
// en memoria, de esta única instancia del proceso. Es intencional (ver
// README: correr una sola instancia del backend). Si algún día hace falta
// escalar a más de un proceso, hay que pasar todo esto a un storage
// compartido (ej. @nest-lab/throttler-storage-redis) — un Map en memoria
// por proceso dejaría de servir para nada en ese escenario.
