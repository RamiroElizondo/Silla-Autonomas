import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ResultadoTurnstile {
  ok: boolean;
  /** Motivo interno para el log; nunca se le muestra tal cual al cliente. */
  motivo?: string;
}

const URL_SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifica el token de Cloudflare Turnstile del botón de pagar (Hallazgo
 * ALTO 2), contra `siteverify`. Diseñado para fallar CERRADO: sin token, con
 * token inválido, o si Cloudflare no contesta, el resultado es `ok: false` y
 * quien llama no debe reservar nada.
 *
 * Si `TURNSTILE_SECRET_KEY` no está configurada, el servicio queda
 * deshabilitado (siempre `ok: true`) — pensado para desarrollo local. En
 * producción hace falta configurarla (ver `verificarEntornoDeArranque`).
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secretKey: string;
  private readonly habilitado: boolean;

  constructor(config: ConfigService) {
    this.secretKey = config.get<string>('TURNSTILE_SECRET_KEY', '');
    this.habilitado = this.secretKey.length > 0;
    if (!this.habilitado) {
      this.logger.warn(
        'TURNSTILE_SECRET_KEY no configurada: la verificación de Turnstile ' +
          'queda deshabilitada (siempre pasa). OK en desarrollo, NUNCA en producción.',
      );
    }
  }

  async verificar(token: string | undefined, ipRemota: string): Promise<ResultadoTurnstile> {
    if (!this.habilitado) return { ok: true };
    if (!token) return { ok: false, motivo: 'sin_token' };

    try {
      const resp = await fetch(URL_SITEVERIFY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: this.secretKey,
          response: token,
          remoteip: ipRemota,
        }),
      });

      if (!resp.ok) {
        this.logger.warn(`Turnstile siteverify respondió HTTP ${resp.status}`);
        return { ok: false, motivo: 'error_http' };
      }

      const data = (await resp.json()) as {
        success?: boolean;
        'error-codes'?: string[];
      };
      if (!data.success) {
        const motivo = (data['error-codes'] ?? []).join(',') || 'no_exitoso';
        return { ok: false, motivo };
      }
      return { ok: true };
    } catch (e) {
      // Falla cerrada: un error de red (Cloudflare no contesta, DNS, etc.)
      // nunca se convierte en "dejar pasar".
      this.logger.warn(`Error de red verificando Turnstile: ${e}`);
      return { ok: false, motivo: 'error_red' };
    }
  }
}
