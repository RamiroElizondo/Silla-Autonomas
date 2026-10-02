import type { FaseTurno } from "@/lib/tipos";
import { BotonControl } from "./BotonControl";

/**
 * Indicaciones para el cliente en los momentos en que tiene que usar el
 * control de la masajeadora (ver backend/src/sesiones/reloj.util.ts):
 *
 *  - GRACIA: el sillón recibió corriente. Hay que apretar START para que
 *    arranque y, cuando aparece la pantalla en el control, apretar OK.
 *  - PAUSA: terminó el masaje; el sillón está apagado unos segundos.
 *  - RETORNO: vuelve la corriente un momento. Apretando START dos veces el
 *    sillón vuelve a la posición normal sin arrancar otro masaje.
 *
 * Cada paso lleva el dibujo del botón para que lo encuentren en el control.
 */
type Paso = { boton: "start" | "ok"; texto: string; veces?: number };

const CONTENIDO: Record<
  "GRACIA" | "PAUSA" | "RETORNO",
  { titulo: string; detalle?: string; pasos: Paso[] }
> = {
  GRACIA: {
    titulo: "Encendé tu masaje con el control",
    pasos: [
      { boton: "start", texto: "Apretá START para que el sillón arranque" },
      {
        boton: "ok",
        texto: "Esperá unos segundos a que aparezca la pantalla en el control y apretá OK",
      },
    ],
  },
  PAUSA: {
    titulo: "Tu masaje terminó",
    detalle:
      "Quedate sentado un momento: el sillón se va a encender de nuevo para volver a levantarse.",
    pasos: [],
  },
  RETORNO: {
    titulo: "Levantá el sillón para bajarte",
    detalle: "El sillón vuelve a la posición normal sin empezar otro masaje.",
    pasos: [{ boton: "start", texto: "Apretá START dos veces", veces: 2 }],
  },
};

export function AvisoFaseSilla({
  fase,
  segundosSalida,
}: {
  fase: FaseTurno | null | undefined;
  segundosSalida?: number | null;
}) {
  if (fase !== "GRACIA" && fase !== "PAUSA" && fase !== "RETORNO") return null;

  const { titulo, detalle, pasos } = CONTENIDO[fase];
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
      <p className="text-[17px] font-medium">{titulo}</p>
      {detalle && (
        <p className={`mt-2 text-sm ${destacado ? "" : "text-tinta-suave"}`}>{detalle}</p>
      )}

      {pasos.length > 0 && (
        <ol className="mt-4 flex flex-col gap-3 text-left">
          {pasos.map((paso, i) => (
            <li
              key={paso.texto}
              className="flex items-center gap-4 rounded-xl bg-white/70 px-4 py-3"
            >
              <div className="relative shrink-0">
                <BotonControl tipo={paso.boton} tamano={64} />
                {paso.veces && paso.veces > 1 && (
                  <span className="absolute -right-2 -top-2 rounded-full bg-terracota px-2 py-0.5 text-xs font-medium text-terracota-claro">
                    ×{paso.veces}
                  </span>
                )}
              </div>
              <p className="text-[15px] leading-snug">
                {pasos.length > 1 && <span className="font-medium">{i + 1}. </span>}
                {paso.texto}
              </p>
            </li>
          ))}
        </ol>
      )}

      {fase !== "GRACIA" && segundosSalida !== null && segundosSalida !== undefined && (
        <p className="mt-4 text-[32px] font-medium leading-none tabular-nums">
          {segundosSalida}s
        </p>
      )}
    </div>
  );
}
