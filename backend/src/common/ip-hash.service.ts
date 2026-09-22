import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Hashea la IP real del cliente con HMAC-SHA256 antes de guardarla en
 * `Sesion.ipHash` / `Turno.ipHash` (Hallazgo ALTO 2): nunca se persiste la
 * IP en claro. El hash no es reversible (HMAC, no un cifrado) y sirve solo
 * para contar cuántas reservas pendientes tiene una misma IP, no para saber
 * cuál es.
 *
 * Sin IP_HASH_SECRET configurado, cae a un secreto fijo de desarrollo (mismo
 * patrón que TurnstileService/PROXY_SHARED_SECRET): sirve para no frenar el
 * desarrollo local, pero en producción hace falta configurarlo de verdad
 * (ver verificarEntornoDeArranque) — sin un secreto real, alguien que
 * conozca este código podría recalcular el hash de una IP puntual.
 */
@Injectable()
export class IpHashService {
  private readonly logger = new Logger(IpHashService.name);
  private readonly secreto: string;

  constructor(config: ConfigService) {
    this.secreto = config.get<string>('IP_HASH_SECRET', '');
    if (!this.secreto) {
      this.logger.warn(
        'IP_HASH_SECRET no configurado: se usa un secreto fijo de desarrollo ' +
          'para hashear IPs. NUNCA usar así en producción.',
      );
    }
  }

  hash(ip: string): string {
    const secreto = this.secreto || 'dev-secreto-inseguro-no-usar-en-produccion';
    return createHmac('sha256', secreto).update(ip).digest('hex');
  }
}
