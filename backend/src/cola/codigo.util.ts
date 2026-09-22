import { randomInt } from 'node:crypto';

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Código de turno: 3 letras + 4 números, ej. "QXP-4821". Es solo para
 * mostrar en pantalla (no protege nada por sí mismo, a diferencia del
 * código de crédito), pero igual usa `crypto.randomInt` y no `Math.random`
 * — no hay razón para que algo que se genera para un cliente use una fuente
 * de aleatoriedad más débil de lo necesario.
 */
export function generarCodigo(): string {
  let letras = '';
  for (let i = 0; i < 3; i++) {
    letras += LETRAS[randomInt(LETRAS.length)];
  }
  const numero = randomInt(10_000).toString().padStart(4, '0');
  return `${letras}-${numero}`;
}
