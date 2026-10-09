"use client";

import type { NumeroOpcion, OpcionMasaje } from "@/lib/tipos";

/**
 * Las dos opciones de masaje del sillón, para elegir antes de pagar. Viene
 * seleccionada la opción por defecto (la 2); el monto que se cobra es el de
 * la opción que quede marcada al tocar "Pagar".
 */
export function SelectorOpcion({
  opciones,
  seleccionada,
  onCambiar,
  deshabilitado = false,
}: {
  opciones: OpcionMasaje[];
  seleccionada: NumeroOpcion;
  onCambiar: (opcion: NumeroOpcion) => void;
  deshabilitado?: boolean;
}) {
  return (
    <div className="mt-6">
      <p id="titulo-opciones" className="text-[13px] text-tinta-muted">
        Elegí tu masaje
      </p>
      <div
        role="radiogroup"
        aria-labelledby="titulo-opciones"
        className="mt-2 grid grid-cols-2 gap-3"
      >
        {opciones.map((o) => {
          const activa = o.opcion === seleccionada;
          return (
            <button
              key={o.opcion}
              type="button"
              role="radio"
              aria-checked={activa}
              disabled={deshabilitado}
              onClick={() => onCambiar(o.opcion)}
              className={`rounded-2xl border p-5 text-left transition disabled:opacity-60 ${
                activa
                  ? "border-terracota bg-terracota-claro"
                  : "border-borde bg-marfil hover:border-borde-fuerte"
              }`}
            >
              <span className="flex items-baseline gap-1.5">
                <span
                  className={`text-[34px] font-medium leading-none tabular-nums ${
                    activa ? "text-terracota-oscuro" : ""
                  }`}
                >
                  {o.duracionMin}
                </span>
                <span
                  className={`text-sm ${activa ? "text-terracota-oscuro" : "text-tinta-suave"}`}
                >
                  min
                </span>
              </span>
              <span
                className={`mt-3 block text-[17px] font-medium tabular-nums ${
                  activa ? "text-terracota-oscuro" : "text-tinta"
                }`}
              >
                ${o.precio.toLocaleString("es-AR")}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
