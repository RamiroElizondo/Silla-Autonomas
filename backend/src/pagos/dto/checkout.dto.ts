import { IsOptional, IsUrl } from 'class-validator';

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
}
