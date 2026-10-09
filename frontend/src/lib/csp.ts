/**
 * Content-Security-Policy (Bloque A del hardening).
 *
 * La fuente Outfit va self-hosted vía @fontsource (ver layout.tsx: importa
 * los .css del paquete, que Next empaqueta como propios) — no hace falta
 * permitir fonts.googleapis.com, todo sale de 'self'.
 *
 * `style-src` necesita 'unsafe-inline' porque `/pantalla` (TV) usa un
 * `style={{ width }}` inline para la barra de progreso (React lo vuelca como
 * atributo `style` en el DOM). Es la única razón; si en algún momento se
 * saca ese inline style (variable CSS + clase), se puede sacar también de acá.
 *
 * `script-src` necesita 'unsafe-eval' SOLO en dev: el runtime de Fast
 * Refresh/HMR de `next dev` (react-refresh-utils) evalúa código para poder
 * reemplazar módulos en caliente. Sin esto, el bundle del navegador tira
 * `Uncaught EvalError` apenas intenta correr, React nunca hidrata, y la
 * página queda congelada en su estado inicial ("Cargando…") para siempre —
 * aunque el servidor esté respondiendo 200 sin problema. `next build`
 * (producción) no necesita eval para nada de esto, así que ahí el CSP real
 * que ve el cliente sigue siendo tan estricto como antes.
 *
 * `frame-ancestors 'none'` en todas las rutas: ninguna vista de este
 * proyecto (ni siquiera la pantalla TV) se abre embebida en un iframe, así
 * que no hace falta una excepción.
 */
export function construirCsp(esDev: boolean, nonce?: string): string {
  // Next.js inyecta scripts inline (bootstrap + payload RSC `self.__next_f`).
  // Sin nonce/hash el navegador los bloquea y la página nunca hidrata
  // ("Connection closed" en consola). El middleware genera un nonce por
  // request; Next lo lee del header CSP y lo aplica a sus scripts.
  const scriptSrc = [
    "'self'",
    ...(nonce ? [`'nonce-${nonce}'`, "'strict-dynamic'"] : []),
    "https://challenges.cloudflare.com",
    ...(esDev ? ["'unsafe-eval'"] : []),
  ].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}
