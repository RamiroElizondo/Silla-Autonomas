import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolverIpConfiable, type RequestConIp } from './client-ip.util';

/**
 * ThrottlerGuard que cuenta por la IP real del cliente (`resolverIpConfiable`)
 * en vez de por `req.ip` (que, detrás del proxy del frontend, es siempre
 * 127.0.0.1 y hace que todos los clientes compartan un solo contador — ver
 * Hallazgo ALTO 1 de la auditoría).
 */
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return resolverIpConfiable(req as RequestConIp);
  }
}
