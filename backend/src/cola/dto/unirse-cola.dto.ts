import { IsIn, IsInt, IsOptional, IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';
import { OPCIONES_VALIDAS } from '../../sillas/opciones.util';

/**
 * `origin` es el origin público desde el que el cliente abrió la landing
 * (window.location.origin). Ver CheckoutDto en pagos/dto — mismo patrón,
 * duplicado acá para no acoplar el módulo de cola al de pagos directos.
 */
export class UnirseColaDto {
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  origin?: string;

  /** Token de Cloudflare Turnstile del botón de pagar. Ver CheckoutDto. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;

  /** Opción de masaje elegida (1 o 2). Ver CheckoutDto. */
  @IsOptional()
  @IsInt()
  @IsIn([...OPCIONES_VALIDAS])
  opcion?: number;

  /**
   * Sillón cuyo QR escaneó el cliente: sus opciones son las que vio en
   * pantalla, así que son las que se cobran (aunque después le toque otro).
   */
  @IsOptional()
  @IsUUID()
  sillaId?: string;
}
