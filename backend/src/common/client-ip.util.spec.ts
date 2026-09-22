import { resolverIpConfiable, type RequestConIp } from './client-ip.util';

function req(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | null = '127.0.0.1',
): RequestConIp {
  return { headers, socket: { remoteAddress } };
}

describe('resolverIpConfiable', () => {
  const SECRETO = 'secreto-de-test-1234';

  beforeEach(() => {
    process.env.PROXY_SHARED_SECRET = SECRETO;
  });

  afterEach(() => {
    delete process.env.PROXY_SHARED_SECRET;
  });

  it('usa x-client-ip cuando el secreto coincide', () => {
    const r = req({ 'x-client-ip': '203.0.113.9', 'x-proxy-secret': SECRETO });
    expect(resolverIpConfiable(r)).toBe('203.0.113.9');
  });

  it('cae al socket si el secreto no coincide', () => {
    const r = req(
      { 'x-client-ip': '203.0.113.9', 'x-proxy-secret': 'otro-secreto' },
      '10.0.0.5',
    );
    expect(resolverIpConfiable(r)).toBe('10.0.0.5');
  });

  it('cae al socket si falta x-proxy-secret', () => {
    const r = req({ 'x-client-ip': '203.0.113.9' }, '10.0.0.5');
    expect(resolverIpConfiable(r)).toBe('10.0.0.5');
  });

  it('cae al socket si falta x-client-ip aunque el secreto sea correcto', () => {
    const r = req({ 'x-proxy-secret': SECRETO }, '10.0.0.5');
    expect(resolverIpConfiable(r)).toBe('10.0.0.5');
  });

  it('cae al socket si PROXY_SHARED_SECRET no está configurado', () => {
    delete process.env.PROXY_SHARED_SECRET;
    const r = req(
      { 'x-client-ip': '203.0.113.9', 'x-proxy-secret': SECRETO },
      '10.0.0.5',
    );
    expect(resolverIpConfiable(r)).toBe('10.0.0.5');
  });

  it('no permite evadir el límite cambiando x-client-ip sin el secreto correcto', () => {
    const r1 = req({ 'x-client-ip': '1.1.1.1' }, '10.0.0.5');
    const r2 = req({ 'x-client-ip': '2.2.2.2' }, '10.0.0.5');
    // Mismo socket, headers distintos y sin secreto válido: misma IP resuelta.
    expect(resolverIpConfiable(r1)).toBe(resolverIpConfiable(r2));
    expect(resolverIpConfiable(r1)).toBe('10.0.0.5');
  });

  it('usa la comparación en tiempo constante (timingSafeEqual) y no un === directo', () => {
    // No podemos medir tiempos de forma confiable en un test, pero sí
    // confirmar que secretos de distinto largo no rompen la comparación
    // (timingSafeEqual explota con buffers de largo distinto si no se
    // maneja aparte) y que el resultado sigue siendo "no coincide".
    const r = req(
      { 'x-client-ip': '203.0.113.9', 'x-proxy-secret': 'corto' },
      '10.0.0.5',
    );
    expect(() => resolverIpConfiable(r)).not.toThrow();
    expect(resolverIpConfiable(r)).toBe('10.0.0.5');
  });

  it('devuelve "desconocida" si ni el socket tiene IP', () => {
    const r = req({}, null);
    expect(resolverIpConfiable(r)).toBe('desconocida');
  });

  it('funciona con IPv6 en x-client-ip', () => {
    const r = req({ 'x-client-ip': '2001:db8::1', 'x-proxy-secret': SECRETO });
    expect(resolverIpConfiable(r)).toBe('2001:db8::1');
  });
});
