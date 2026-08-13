import { IsOptional, IsUrl } from 'class-validator';

/**
 * `origin` es el origin público desde el que el cliente abrió la landing
 * (window.location.origin) — típicamente el dominio del túnel de cloudflared,
 * o el dominio real en producción. Se usa para armar el notification_url del
 * webhook y los back_urls de la preferencia sin depender de un env var fijo.
 * Es opcional: si no viene, se usa FRONTEND_URL/BACKEND_URL del .env.
 */
export class CheckoutDto {
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  origin?: string;
}
