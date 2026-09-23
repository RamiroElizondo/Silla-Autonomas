import { Logger } from '@nestjs/common';

const logger = new Logger('VerificarEntorno');

/**
 * Chequeos de arranque que fallan RÁPIDO en producción si falta una
 * variable de entorno de seguridad, en vez de arrancar en un estado
 * silenciosamente inseguro. Se llama una sola vez desde `main.ts`, antes de
 * levantar el servidor HTTP.
 */
export function verificarEntornoDeArranque(): void {
  const produccion = process.env.NODE_ENV === 'production';

  if (!process.env.PROXY_SHARED_SECRET) {
    if (produccion) {
      throw new Error(
        'PROXY_SHARED_SECRET es obligatorio en producción: sin él, el rate ' +
          'limit por IP no distingue clientes reales (todo llega desde el ' +
          'proxy del frontend con la misma IP de socket).',
      );
    }
    logger.warn(
      'PROXY_SHARED_SECRET no configurado: el rate limit va a contar por ' +
        'la IP del socket (probablemente la misma para todos los clientes, ' +
        'vía el proxy del frontend). OK en desarrollo, NUNCA en producción.',
    );
  }

  if (!process.env.TURNSTILE_SECRET_KEY) {
    if (produccion) {
      throw new Error(
        'TURNSTILE_SECRET_KEY es obligatorio en producción: sin él, ' +
          'cualquier script puede reservar sillas repetidamente sin pagar ' +
          '(ver TurnstileService).',
      );
    }
    logger.warn(
      'TURNSTILE_SECRET_KEY no configurada: la verificación de Turnstile en ' +
        'el checkout queda deshabilitada. OK en desarrollo, NUNCA en producción.',
    );
  }

  if (!process.env.IP_HASH_SECRET) {
    if (produccion) {
      throw new Error(
        'IP_HASH_SECRET es obligatorio en producción: sin un secreto propio, ' +
          'el hash de IP guardado en Sesion/Turno usa un valor fijo conocido ' +
          '(ver IpHashService).',
      );
    }
    logger.warn(
      'IP_HASH_SECRET no configurado: se usa un secreto fijo de desarrollo ' +
        'para hashear IPs. OK en desarrollo, NUNCA en producción.',
    );
  }

  if (!process.env.MP_WEBHOOK_SECRET) {
    if (produccion) {
      // A diferencia de los otros 3 chequeos, acá NO hay excepción posible
      // en producción: MP_WEBHOOK_ALLOW_UNSIGNED solo se respeta fuera de
      // producción (ver MercadoPagoService). Sin secreto, en producción el
      // webhook rechazaría TODAS las notificaciones de pago — mejor no
      // arrancar que arrancar sordo a los pagos.
      throw new Error(
        'MP_WEBHOOK_SECRET es obligatorio en producción: sin él, el webhook ' +
          'de Mercado Pago no puede validar ninguna notificación de pago ' +
          '(ver MercadoPagoService.validarFirma).',
      );
    }
    if (process.env.MP_WEBHOOK_ALLOW_UNSIGNED === 'true') {
      logger.warn(
        'MP_WEBHOOK_SECRET no configurado y MP_WEBHOOK_ALLOW_UNSIGNED=true: ' +
          'el webhook de Mercado Pago acepta notificaciones SIN validar ' +
          'firma. Es un agujero de seguridad — NUNCA en producción.',
      );
    } else {
      logger.warn(
        'MP_WEBHOOK_SECRET no configurado: el webhook de Mercado Pago va a ' +
          'rechazar todas las notificaciones (falla cerrado). OK en ' +
          'desarrollo si no estás probando pagos; configurá el secreto, o ' +
          '(solo en desarrollo) MP_WEBHOOK_ALLOW_UNSIGNED=true.',
      );
    }
  }

  // Bloque de loadtest (backend/loadtest/): LOADTEST=true reemplaza
  // MercadoPagoService y ShellyService.setRele por respuestas simuladas
  // (pago siempre aprobado, relé siempre "encendido" sin red real) para
  // poder tirar carga sin gastar plata real de Mercado Pago ni reventar el
  // límite de ~1 req/seg de la Shelly Cloud API. Si esto llegara a
  // producción, el sistema aprobaría pagos falsos y reportaría sillas
  // "encendidas" que en realidad nunca reciben corriente — mucho peor que
  // no arrancar. A diferencia de MP_WEBHOOK_ALLOW_UNSIGNED, acá NO hay
  // ninguna bandera de escape: nunca hay una razón legítima para esto en
  // producción.
  if (process.env.LOADTEST === 'true') {
    if (produccion) {
      throw new Error(
        'LOADTEST=true no puede usarse con NODE_ENV=production: el ' +
          'servidor aprobaría pagos simulados de Mercado Pago y ' +
          '"encendería" sillas que en realidad no reciben corriente (ver ' +
          'MercadoPagoService y ShellyService.setRele). Sacá LOADTEST del ' +
          'entorno de producción.',
      );
    }
    logger.warn(
      'LOADTEST=true: Mercado Pago y Shelly Cloud están MOCKEADOS (pagos ' +
        'siempre aprobados, relé simulado sin red real). Solo para correr ' +
        'las pruebas de carga de backend/loadtest/ — NUNCA en producción.',
    );
  }
}

/**
 * Resuelve el `origin` que se le pasa a `app.enableCors()` a partir de
 * `CORS_ORIGINS` (lista separada por comas). El navegador ya no le pega
 * directo al backend en producción — todo pasa por el proxy /api del
 * frontend (server-to-server, sin CORS de por medio, ver `main.ts`) — así
 * que esto es sobre todo defensa en profundidad y comodidad de desarrollo
 * (curl/Postman/Swagger, o un futuro consumidor directo desde el navegador).
 *
 * - `CORS_ORIGINS` configurada: se separa por comas y se recortan espacios;
 *   esos son los únicos orígenes permitidos.
 * - Sin configurar, en desarrollo: refleja cualquier origen (`origin: true`),
 *   igual que antes de que existiera esta variable. Solo aviso en el log.
 * - Sin configurar, en producción: a diferencia de los chequeos de arriba,
 *   esto NO aborta el arranque (no hay pago ni webhook en juego, y la única
 *   vía real del navegador al backend ya pasa por el proxy same-origin del
 *   frontend) — pero tampoco hay que reflejar cualquier origen a ciegas en
 *   producción, así que falla CERRADO: `origin: false` rechaza cualquier
 *   pedido cross-origin del navegador (curl/Postman/servidor-a-servidor no
 *   dependen de CORS y siguen funcionando igual).
 */
export function resolverCorsOrigins(): boolean | string[] {
  const crudo = process.env.CORS_ORIGINS;
  if (crudo && crudo.trim() !== '') {
    return crudo
      .split(',')
      .map((origen) => origen.trim())
      .filter((origen) => origen.length > 0);
  }

  if (process.env.NODE_ENV === 'production') {
    logger.warn(
      'CORS_ORIGINS no configurada en producción: se rechaza cualquier ' +
        'pedido cross-origin del navegador (falla cerrado). Si hay un ' +
        'consumidor directo desde el navegador (no vía el proxy same-origin ' +
        'del frontend), configurar CORS_ORIGINS con los orígenes permitidos, ' +
        'separados por coma.',
    );
    return false;
  }

  logger.warn(
    'CORS_ORIGINS no configurada: se refleja cualquier origen (CORS ' +
      'abierto). OK en desarrollo, NUNCA en producción.',
  );
  return true;
}
