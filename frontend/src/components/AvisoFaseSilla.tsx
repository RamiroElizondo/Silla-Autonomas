import type { StaticImageData } from "next/image";
import escaneoControl from "@/assets/control-escaneo.png";
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
 * El del OK lleva además, arriba, lo que muestra la pantalla del control en
 * ese momento (el escaneo corporal, sacado del manual del Smart 3D), para que
 * el cliente reconozca cuándo tiene que apretarlo.
 */
type Paso = {
  boton: "start" | "ok";
  texto: string;
  veces?: number;
  pantalla?: { imagen: StaticImageData; alt: string };
};

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
        texto:
          "Espere unos segundos a que aparezca en la pantalla del control la imagen de arriba y presione OK",
        pantalla: {
          imagen: escaneoControl,
          alt: "Pantalla del control: una persona sentada con puntos en la espalda y la palabra Loading",
        },
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
    titulo: "Levanta el sillón para bajarte",
    detalle: "El sillón vuelve a la posición normal.",
    pasos: [{ boton: "start", texto: "Presione START dos veces", veces: 2 }],
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
          ? "border-brand bg-brand-soft text-brand-ink"
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
            <li key={paso.texto} className="rounded-xl bg-white/70 px-4 py-3">
              {paso.pantalla && (
                // Marco gris claro, como la pantalla del control remoto.
                <div className="mx-auto mb-3 w-44 rounded-lg border-2 border-tinta bg-[#f2f2f2] p-3">
                  <img
                    src={paso.pantalla.imagen.src}
                    alt={paso.pantalla.alt}
                    width={paso.pantalla.imagen.width}
                    height={paso.pantalla.imagen.height}
                    className="h-auto w-full"
                  />
                </div>
              )}
              <div className="flex items-center gap-4">
                <div className="relative shrink-0">
                  <BotonControl tipo={paso.boton} tamano={64} />
                  {paso.veces && paso.veces > 1 && (
                    <span className="absolute -right-2 -top-2 rounded-full bg-brand-strong px-2 py-0.5 text-xs font-medium text-white">
                      ×{paso.veces}
                    </span>
                  )}
                </div>
                <p className="text-[15px] leading-snug">
                  {pasos.length > 1 && <span className="font-medium">{i + 1}. </span>}
                  {paso.texto}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {fase !== "GRACIA" && segundosSalida !== null && segundosSalida !== undefined && (
        <p className="mt-4 text-[32px] font-medium leading-none tabular-nums">{segundosSalida}s</p>
      )}
    </div>
  );
}
