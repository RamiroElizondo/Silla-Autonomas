/**
 * Funciones puras de sondeo (Bloque C), sin React ni DOM: la lógica de
 * "¿toca sondear ahora?" y "¿cuánto hay que esperar hasta el próximo
 * pedido?" vive acá para poder testearla con Vitest sin renderizar nada, y
 * la usan los hooks useEstadoSilla/useEstadoSesion/useEstadoTurno y el
 * polling inline de la landing.
 */

/**
 * Si la pestaña está oculta y el llamador pidió pausar en ese caso, no hay
 * que sondear. La pantalla TV (`app/pantalla/page.tsx`) pasa `pausarEnOculto:
 * false` porque es un display de pared: nadie cambia de pestaña ahí, y aun
 * si `visibilitychange` disparara por algún motivo, tiene que seguir
 * sondeando igual.
 */
export function debeSondearAhora(params: {
  oculto: boolean;
  pausarEnOculto: boolean;
}): boolean {
  return !(params.pausarEnOculto && params.oculto);
}

/**
 * Milisegundos desde ahora que indica un header `Retry-After`, o `null` si
 * no vino o no se pudo interpretar. Acepta las dos formas que permite la
 * spec HTTP: segundos delta ("120", el caso común de esta API) y una fecha
 * HTTP completa (`Date.parse` como fallback razonable, sin parsear el
 * formato a mano).
 */
export function parsearRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const fecha = Date.parse(trimmed);
  if (Number.isNaN(fecha)) return null;
  return Math.max(0, fecha - Date.now());
}

/**
 * Cuánto esperar hasta el próximo sondeo: nunca antes del intervalo normal,
 * pero más si el servidor pidió un backoff mayor con Retry-After.
 */
export function proximoRetrasoMs(params: {
  intervaloBaseMs: number;
  retryAfterMs: number | null;
}): number {
  return Math.max(params.intervaloBaseMs, params.retryAfterMs ?? 0);
}
