import { timingSafeEqual } from 'node:crypto';

/** Lo mínimo que necesitamos de la request para resolver la IP: headers
 * (Express los normaliza a minúscula y string | string[] | undefined) y el
 * socket de la conexión TCP. */
export interface RequestConIp {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | null };
}

function primerValor(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function comparacionSegura(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // timingSafeEqual exige buffers del mismo largo. Comparamos el buffer
    // recibido contra sí mismo para no introducir una rama sin costo de
    // tiempo — igual no es un secreto de alta sensibilidad (es compartido
    // entre dos procesos propios), pero no cuesta nada hacerlo bien.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * IP "confiable" del cliente real, para rate limiting y para los topes por
 * IP de checkout/canje.
 *
 * Nunca usa `req.ip` ni `X-Forwarded-For` crudo: cualquiera que le pegue al
 * proxy del frontend (o directo al backend, en desarrollo) puede mandar esos
 * headers con el valor que quiera, y el proxy reenvía todos los headers del
 * cliente salvo los que borra explícitamente.
 *
 * Solo confía en el header `x-client-ip` cuando viene acompañado del
 * secreto compartido con el proxy (`x-proxy-secret`), comparado en tiempo
 * constante contra `PROXY_SHARED_SECRET`. Si el secreto no coincide, no está
 * configurado, o falta cualquiera de los dos headers, cae a la IP del socket
 * de la conexión TCP — que, detrás de un único proxy confiable, es siempre
 * la del proxy (no distingue clientes entre sí), pero no se puede
 * falsificar desde afuera.
 */
export function resolverIpConfiable(req: RequestConIp): string {
  const secretoEsperado = process.env.PROXY_SHARED_SECRET;
  const secretoRecibido = primerValor(req.headers['x-proxy-secret']);
  const ipDeclarada = primerValor(req.headers['x-client-ip'])?.trim();

  if (
    secretoEsperado &&
    secretoRecibido &&
    ipDeclarada &&
    comparacionSegura(secretoRecibido, secretoEsperado)
  ) {
    return ipDeclarada;
  }

  return req.socket.remoteAddress ?? 'desconocida';
}
