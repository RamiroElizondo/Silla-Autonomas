const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Código de turno: 3 letras + 4 números, ej. "QXP-4821". */
export function generarCodigo(): string {
  let letras = '';
  for (let i = 0; i < 3; i++) {
    letras += LETRAS[Math.floor(Math.random() * LETRAS.length)];
  }
  const numero = Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0');
  return `${letras}-${numero}`;
}
