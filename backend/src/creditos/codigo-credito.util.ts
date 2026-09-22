import { randomInt } from 'node:crypto';

/**
 * Alfabeto sin caracteres ambiguos al leerlos en voz alta o escritos a mano:
 * sin 0/O, sin 1/I/L. 31 símbolos (8 dígitos + 23 letras).
 */
export const ALFABETO_CODIGO_CREDITO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Caracteres del cuerpo del código (sin contar "LUZ-" ni los guiones). */
const LONGITUD_CUERPO = 8;

/**
 * Código de crédito: "LUZ-XXXX-XXXX", con el cuerpo generado con
 * `crypto.randomInt` (no `Math.random`, que no es apto para nada que haya
 * que hacer difícil de adivinar). 31^8 ≈ 8.5×10^11 combinaciones — antes
 * eran 10.000.
 */
export function generarCodigoCredito(): string {
  let cuerpo = '';
  for (let i = 0; i < LONGITUD_CUERPO; i++) {
    cuerpo += ALFABETO_CODIGO_CREDITO[randomInt(ALFABETO_CODIGO_CREDITO.length)];
  }
  return `LUZ-${cuerpo.slice(0, 4)}-${cuerpo.slice(4)}`;
}

/**
 * Normaliza lo que el cliente tipea: mayúsculas, espacios y guiones
 * olvidados o de más. Acepta tanto el formato nuevo ("LUZ-A2B4-9CDE", 11
 * caracteres limpios) como el formato viejo de antes de este hardening
 * ("LUZ-4821", 7 caracteres limpios) — los vales viejos que ya estén en la
 * base tienen que seguir siendo canjeables.
 */
export function normalizarCodigo(entrada: string): string {
  const limpio = entrada.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (limpio.length === 7) {
    // Formato viejo: LUZ + 4 dígitos.
    return `${limpio.slice(0, 3)}-${limpio.slice(3)}`;
  }
  if (limpio.length === 11) {
    // Formato nuevo: LUZ + 8 caracteres.
    return `${limpio.slice(0, 3)}-${limpio.slice(3, 7)}-${limpio.slice(7)}`;
  }
  return limpio;
}
