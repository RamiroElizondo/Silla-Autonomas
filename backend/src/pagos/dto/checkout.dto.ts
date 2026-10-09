import { IsIn, IsInt, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { OPCIONES_VALIDAS } from '../../sillas/opciones.util';

/**
 * `origin` es el origin público desde el que el cliente abrió la landing
 * (window.location.origin) — típicamente el dominio del túnel de cloudflared,
 * o el dominio real en producción. Se usa para armar los back_urls de la
 * preferencia. El Webhook se configura por separado en Mercado Pago.
 * Es opcional: si no viene, se usa FRONTEND_URL del .env.
 */
export class CheckoutDto {
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  origin?: string;

  /**
   * Token del widget de Cloudflare Turnstile del botón "Pagar" (Hallazgo
   * ALTO 2). Se verifica en el backend antes de reservar la silla. Opcional
   * a nivel DTO porque TurnstileService decide si es obligatorio según
   * TURNSTILE_SECRET_KEY/NODE_ENV, no el validador del DTO.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;

  /** Opción de masaje elegida (1 o 2). Sin valor, la opción por defecto (2). */
  @IsOptional()
  @IsInt()
  @IsIn([...OPCIONES_VALIDAS])
  opcion?: number;
}
