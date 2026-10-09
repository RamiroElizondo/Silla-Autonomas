/**
 * Opciones de masaje de un sillón. Cada sillón tiene dos, editables desde el
 * panel (por defecto 5 y 10 minutos); el cliente elige antes de pagar y la
 * landing trae la opción 2 seleccionada.
 *
 * Lo elegido se copia a la Sesion/Turno (`duracionMin`, `monto`, `opcion`):
 * de ahí en adelante nadie vuelve a mirar la silla para saber cuánto dura o
 * cuánto se cobró, igual que con los tiempos de gracia y retorno.
 */
export const OPCIONES_VALIDAS = [1, 2] as const;
export type NumeroOpcion = (typeof OPCIONES_VALIDAS)[number];

/** La que viene seleccionada en la landing y la que se usa si no llega ninguna. */
export const OPCION_POR_DEFECTO: NumeroOpcion = 2;

export interface OpcionesDeSilla<P> {
  opcion1DuracionMin: number;
  opcion1Precio: P;
  opcion2DuracionMin: number;
  opcion2Precio: P;
}

/** Duración y monto de la opción elegida, con el precio tal como viene de la base. */
export function opcionDe<P>(
  silla: OpcionesDeSilla<P>,
  opcion: number | null | undefined = OPCION_POR_DEFECTO,
): { opcion: NumeroOpcion; duracionMin: number; monto: P } {
  if (opcion === 1) {
    return { opcion: 1, duracionMin: silla.opcion1DuracionMin, monto: silla.opcion1Precio };
  }
  return { opcion: 2, duracionMin: silla.opcion2DuracionMin, monto: silla.opcion2Precio };
}

/** Las dos opciones listas para la landing/TV (precio como number). */
export function opcionesPublicas(silla: OpcionesDeSilla<unknown>) {
  return OPCIONES_VALIDAS.map((n) => {
    const o = opcionDe(silla, n);
    return { opcion: o.opcion, duracionMin: o.duracionMin, precio: Number(o.monto) };
  });
}
