import type { FaseTurno } from "@/lib/tipos";

/**
 * Indicaciones para el cliente en los momentos en que tiene que tocar el
 * botón START de la masajeadora (ver backend/src/sesiones/reloj.util.ts):
 *
 *  - GRACIA: la silla recibió corriente y espera START para reclinarse y
 *    arrancar el masaje. El reloj queda quieto mientras tanto.
 *  - PAUSA: terminó el masaje; la silla está apagada unos segundos.
 *  - RETORNO: vuelve la corriente un momento para que, con START, la silla
 *    se levante y el cliente pueda bajarse.
 */
export function AvisoFaseSilla({
  fase,
  segundosSalida,
}: {
  fase: FaseTurno | null | undefined;
  segundosSalida?: number | null;
}) {
  if (fase !== "GRACIA" && fase !== "PAUSA" && fase !== "RETORNO") return null;

  const textos = {
    GRACIA: {
      titulo: "Presioná START en el sillón",
      detalle:
        "Con el botón START del control el sillón se reclina y empieza tu masaje.",
    },
    PAUSA: {
      titulo: "Tu masaje terminó",
      detalle:
        "Quedate sentado un momento: el sillón se va a encender de nuevo para volver a levantarse.",
    },
    RETORNO: {
      titulo: "Presioná START ahora",
      detalle:
        "El sillón vuelve a la posición vertical para que puedas bajarte con comodidad.",
    },
  }[fase];

  const destacado = fase !== "PAUSA";

  return (
    <div
      role="status"
      className={`mt-6 w-full rounded-2xl border p-6 text-center ${
        destacado
          ? "border-terracota bg-terracota-claro text-terracota-oscuro"
          : "border-arena bg-panal"
      }`}
    >
      <p className="text-[17px] font-medium">{textos.titulo}</p>
      <p className={`mt-2 text-sm ${destacado ? "" : "text-tinta-suave"}`}>{textos.detalle}</p>
      {fase !== "GRACIA" && segundosSalida !== null && segundosSalida !== undefined && (
        <p className="mt-3 text-[32px] font-medium leading-none tabular-nums">
          {segundosSalida}s
        </p>
      )}
    </div>
  );
}
