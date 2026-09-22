import { describe, expect, it } from 'vitest';
import { resolverIpCliente } from './resolver-ip-cliente';

function headersDe(valores: Record<string, string>): Headers {
  return new Headers(valores);
}

describe('resolverIpCliente', () => {
  it('prioriza cf-connecting-ip aunque venga también un x-forwarded-for', () => {
    const headers = headersDe({
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(resolverIpCliente(headers)).toBe('203.0.113.7');
  });

  it('ignora un x-forwarded-for falsificado por el cliente cuando no hay cf-connecting-ip', () => {
    const headers = headersDe({ 'x-forwarded-for': '9.9.9.9' });
    expect(resolverIpCliente(headers)).toBeNull();
  });

  it('devuelve null con headers vacíos', () => {
    const headers = headersDe({});
    expect(resolverIpCliente(headers)).toBeNull();
  });

  it('devuelve null si cf-connecting-ip viene vacío o solo espacios', () => {
    const headers = headersDe({ 'cf-connecting-ip': '   ' });
    expect(resolverIpCliente(headers)).toBeNull();
  });

  it('acepta una IPv6 tal cual', () => {
    const headers = headersDe({ 'cf-connecting-ip': '2001:db8::1' });
    expect(resolverIpCliente(headers)).toBe('2001:db8::1');
  });
});
