/**
 * TTL de la cache en memoria (`TtlCache`) para los 4 endpoints públicos de
 * "estado" que sondean el celular del cliente y la pantalla TV del local:
 * `/sillas/:id/estado`, `/sesiones/:id/estado`, `/cola/estado` y
 * `/cola/:id/estado`.
 *
 * Vive separado de `throttle.config.ts` porque no es un límite de rate
 * limiting: ahí van los topes de "cuántos pedidos por minuto", acá el techo
 * de "cuán vieja puede ser una lectura antes de volver a pegarle a la base".
 *
 * Absorbe ráfagas de sondeo — varios celulares y la TV pidiendo el estado de
 * la misma silla/sesión/turno dentro de la misma fracción de segundo no
 * generan una consulta a la base por cada uno — sin que la demora que le
 * suma a un cambio de estado real (pago aprobado, corte de energía) sea
 * perceptible para el cliente. Las transiciones que importan además
 * invalidan la cache al toque (ver los `invalidarCache*` de
 * SillasService/SesionesService/ColaService); este TTL es solo el techo de
 * qué tan vieja puede quedar una lectura cuando, por una dependencia
 * circular entre módulos, esa invalidación explícita no se pudo cablear
 * (documentado caso por caso donde pasa).
 */
export const CACHE_TTL_ESTADO_MS = 1500;
