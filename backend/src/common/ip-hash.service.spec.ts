import { ConfigService } from '@nestjs/config';
import { IpHashService } from './ip-hash.service';

function configCon(valores: Record<string, string>): ConfigService {
  return {
    get: (clave: string, valorPorDefecto?: string) => valores[clave] ?? valorPorDefecto,
  } as unknown as ConfigService;
}

describe('IpHashService', () => {
  it('produce un hash hexadecimal de 64 caracteres (sha256)', () => {
    const servicio = new IpHashService(configCon({ IP_HASH_SECRET: 'secreto' }));
    const hash = servicio.hash('200.1.2.3');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('es determinístico: la misma IP da siempre el mismo hash', () => {
    const servicio = new IpHashService(configCon({ IP_HASH_SECRET: 'secreto' }));
    expect(servicio.hash('200.1.2.3')).toBe(servicio.hash('200.1.2.3'));
  });

  it('no es reversible: el hash no contiene la IP en ninguna forma reconocible', () => {
    const servicio = new IpHashService(configCon({ IP_HASH_SECRET: 'secreto' }));
    const hash = servicio.hash('200.1.2.3');
    expect(hash).not.toContain('200');
    expect(hash).not.toContain('200.1.2.3');
  });

  it('IPs distintas dan hashes distintos', () => {
    const servicio = new IpHashService(configCon({ IP_HASH_SECRET: 'secreto' }));
    expect(servicio.hash('200.1.2.3')).not.toBe(servicio.hash('200.1.2.4'));
  });

  it('secretos distintos dan hashes distintos para la misma IP', () => {
    const a = new IpHashService(configCon({ IP_HASH_SECRET: 'secreto-a' }));
    const b = new IpHashService(configCon({ IP_HASH_SECRET: 'secreto-b' }));
    expect(a.hash('200.1.2.3')).not.toBe(b.hash('200.1.2.3'));
  });
});
