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
}
