/** Lo mínimo de la interfaz de Headers que necesitamos, para poder testear
 * esta función con un objeto plano en vez de un Headers real del DOM. */
export interface CabecerasConGet {
  get(nombre: string): string | null;
}

/**
 * Resuelve la IP real del cliente a partir de los headers de la request que
 * le llega al proxy `/api` del frontend.
 *
 * Solo confía en `cf-connecting-ip`: Cloudflare la pisa con la IP real de
 * quien conecta a su red — el cliente no la puede falsificar, a diferencia
 * de `x-forwarded-for`, `x-real-ip` o `forwarded`, que cualquiera que le
 * pegue al proxy puede mandar con el valor que quiera. Por eso esos headers
 * NUNCA se leen acá, ni siquiera como respaldo.
 *
 * Sin Cloudflare por delante (desarrollo local, o si cambia el túnel) no hay
 * forma confiable de saber la IP desde los headers: se devuelve `null` y
 * quien reenvía la request al backend simplemente no manda `x-client-ip`,
 * con lo que el backend cae a la IP del socket de esa conexión (ver
 * `resolverIpConfiable` en el backend).
 */
export function resolverIpCliente(headers: CabecerasConGet): string | null {
  const valor = headers.get('cf-connecting-ip');
  if (!valor) return null;
  const limpio = valor.trim();
  return limpio.length > 0 ? limpio : null;
}
