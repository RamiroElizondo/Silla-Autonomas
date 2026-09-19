/**
 * Código de crédito: prefijo fijo "LUZ" + 4 números, ej. "LUZ-4821".
 * El prefijo es distinto del de los turnos (3 letras al azar) a propósito:
 * el cliente tiene los dos códigos en la pantalla y no se tienen que
 * confundir entre sí.
 */
export function generarCodigoCredito(): string {
  const numero = Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0');
  return `LUZ-${numero}`;
}

/**
 * Normaliza lo que el cliente tipea: minúsculas, espacios, guión olvidado.
 * "luz 4821" / "luz4821" / "LUZ-4821" → "LUZ-4821".
 */
export function normalizarCodigo(entrada: string): string {
  const limpio = entrada.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (limpio.length === 7) return `${limpio.slice(0, 3)}-${limpio.slice(3)}`;
  return limpio;
}
