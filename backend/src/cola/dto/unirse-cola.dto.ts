import { IsOptional, IsUrl } from 'class-validator';

/**
 * `origin` es el origin público desde el que el cliente abrió la landing
 * (window.location.origin). Ver CheckoutDto en pagos/dto — mismo patrón,
 * duplicado acá para no acoplar el módulo de cola al de pagos directos.
 */
export class UnirseColaDto {
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  origin?: string;
}
