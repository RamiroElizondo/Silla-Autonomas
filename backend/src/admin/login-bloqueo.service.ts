import { Injectable } from '@nestjs/common';

/** Ventana en la que se cuentan los intentos fallidos. */
const VENTANA_MS = 15 * 60_000;
/** Cuánto dura el bloqueo una vez alcanzado el máximo. */
const BLOQUEO_MS = 15 * 60_000;
/** Intentos fallidos permitidos dentro de la ventana antes de bloquear. */
const MAX_INTENTOS = 10;

interface EstadoIntentos {
  intentos: number;
  primerIntentoEn: number;
  bloqueadoHasta: number | null;
}

/**
 * Bloqueo por cuenta tras fallos repetidos de login (hallazgo MEDIO),
 * independiente del rate limit por IP (@Throttle en AuthController, ver
 * LIMITE_LOGIN): dos clientes distintos del mismo WiFi no deberían poder
 * bloquearse entre sí, pero sí hace falta frenar a alguien insistiendo
 * contra la MISMA cuenta desde IPs distintas.
 *
 * Cuenta también los intentos contra emails inexistentes: si no lo hiciera,
 * el bloqueo mismo sería un oráculo ("este email nunca se bloquea, no debe
 * existir"). El mensaje de error es siempre el mismo genérico (429 sin
 * detalle) tanto si la cuenta existe y está bloqueada como si no existe.
 *
 * En memoria, por proceso — mismo criterio que el resto del rate limiting
 * de este proyecto (ver throttle.config.ts): una sola instancia del backend.
 */
@Injectable()
export class LoginBloqueoService {
  private estados = new Map<string, EstadoIntentos>();

  /** true si el email está bloqueado en este momento. */
  estaBloqueado(email: string): boolean {
    const clave = this.normalizar(email);
    const estado = this.estados.get(clave);
    if (!estado?.bloqueadoHasta) return false;
    if (Date.now() >= estado.bloqueadoHasta) {
      this.estados.delete(clave);
      return false;
    }
    return true;
  }

  /**
   * Registra un intento fallido; bloquea el email si llega al máximo dentro
   * de la ventana. Si la ventana anterior ya venció, arranca una nueva.
   */
  registrarFallo(email: string): void {
    const clave = this.normalizar(email);
    const ahora = Date.now();
    const estado = this.estados.get(clave);

    if (!estado || ahora - estado.primerIntentoEn > VENTANA_MS) {
      this.estados.set(clave, {
        intentos: 1,
        primerIntentoEn: ahora,
        bloqueadoHasta: null,
      });
      return;
    }

    estado.intentos += 1;
    if (estado.intentos >= MAX_INTENTOS) {
      estado.bloqueadoHasta = ahora + BLOQUEO_MS;
    }
  }

  /** Login exitoso: limpia el historial de fallos de este email. */
  registrarExito(email: string): void {
    this.estados.delete(this.normalizar(email));
  }

  private normalizar(email: string): string {
    return email.trim().toLowerCase();
  }
}
