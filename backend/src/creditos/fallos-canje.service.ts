import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  BLOQUEO_CANJE_MS,
  MAX_FALLOS_CANJE,
  VENTANA_FALLOS_CANJE_MS,
} from '../common/throttle.config';

interface EstadoIp {
  /** Timestamps (ms) de intentos fallidos dentro de la ventana actual. */
  fallos: number[];
  /** Si está bloqueada, hasta cuándo (ms epoch). */
  bloqueadaHasta?: number;
}

/**
 * Freno anti fuerza-bruta para `/cola/canjear` (Hallazgo ALTO 3), en memoria
 * y por IP: el 5/min de `@Throttle` en el endpoint ya frena la velocidad,
 * pero no evita que alguien pruebe códigos durante horas a ese ritmo. Acá
 * contamos fallos en una ventana de 1h y bloqueamos 1h al llegar a
 * `MAX_FALLOS_CANJE` — un éxito no cuenta como fallo y limpia el historial.
 *
 * En memoria y de una sola instancia, igual que el resto del rate limiting
 * de este proyecto (ver `common/throttle.config.ts`): no sobrevive un
 * reinicio ni se comparte entre instancias, y no hace falta que lo haga
 * para este despliegue de un solo servidor.
 */
@Injectable()
export class FallosCanjeService {
  private readonly logger = new Logger(FallosCanjeService.name);
  private readonly porIp = new Map<string, EstadoIp>();

  /** Lanza 429 si la IP está bloqueada en este momento. */
  verificarNoBloqueado(ip: string): void {
    const estado = this.porIp.get(ip);
    if (!estado?.bloqueadaHasta) return;

    if (estado.bloqueadaHasta > Date.now()) {
      throw new HttpException(
        'Demasiados intentos fallidos. Probá de nuevo más tarde.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // El bloqueo ya venció: limpiamos para no arrastrar estado viejo.
    this.porIp.delete(ip);
  }

  /** Un canje válido borra el historial de fallos de esa IP. */
  registrarExito(ip: string): void {
    this.porIp.delete(ip);
  }

  /** Un canje inválido suma un fallo; bloquea si llega al máximo. */
  registrarFallo(ip: string): void {
    const ahora = Date.now();
    const estado = this.porIp.get(ip) ?? { fallos: [] };

    estado.fallos = estado.fallos.filter(
      (t) => ahora - t < VENTANA_FALLOS_CANJE_MS,
    );
    estado.fallos.push(ahora);

    if (estado.fallos.length >= MAX_FALLOS_CANJE) {
      estado.bloqueadaHasta = ahora + BLOQUEO_CANJE_MS;
      this.logger.warn(
        `IP bloqueada 1h para canje de vales tras ${estado.fallos.length} fallos`,
      );
    }

    this.porIp.set(ip, estado);
  }
}
