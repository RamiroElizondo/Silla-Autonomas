import type { EstadoSilla } from "@/lib/tipos";

const config: Record<
  EstadoSilla,
  { texto: string; fondo: string; texto_color: string; punto: string }
> = {
  LIBRE: {
    texto: "Libre",
    fondo: "bg-salvia-claro",
    texto_color: "text-salvia-oscuro",
    punto: "bg-salvia",
  },
  PAGO_PENDIENTE: {
    texto: "Reservado",
    fondo: "bg-panal",
    texto_color: "text-tinta-suave",
    punto: "bg-arena",
  },
  RESERVADA: {
    texto: "Reservado",
    fondo: "bg-panal",
    texto_color: "text-tinta-suave",
    punto: "bg-arena",
  },
  EN_USO: {
    texto: "En uso",
    fondo: "bg-terracota-claro",
    texto_color: "text-terracota-oscuro",
    punto: "bg-terracota",
  },
  FUERA_DE_SERVICIO: {
    texto: "Fuera de servicio",
    fondo: "bg-pista",
    texto_color: "text-tinta-muted",
    punto: "bg-tinta-muted",
  },
};

/** Sin conexión con el relé: lo tratamos como un estado propio, porque para
 *  el cliente no es lo mismo "ocupada" que "no la podemos encender". */
const SIN_ENERGIA = {
  texto: "Sin conexión",
  fondo: "bg-panal",
  texto_color: "text-tinta-suave",
  punto: "bg-arena",
};

export function EstadoBadge({
  estado,
  sufijo,
  sinEnergia = false,
  grande = false,
}: {
  estado: EstadoSilla;
  sufijo?: string;
  sinEnergia?: boolean;
  /** Versión para la pantalla TV, escalada con la altura de la pantalla. */
  grande?: boolean;
}) {
  const c = sinEnergia && estado !== "FUERA_DE_SERVICIO" ? SIN_ENERGIA : config[estado];
  const tamano = grande
    ? "gap-[1vh] px-[1.8vh] py-[0.7vh] text-[2.4vh]"
    : "gap-2 px-3.5 py-1.5 text-[13px]";
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${tamano} ${c.fondo} ${c.texto_color}`}
    >
      <span className={`rounded-full ${grande ? "h-[1.2vh] w-[1.2vh]" : "h-2 w-2"} ${c.punto}`} />
      {c.texto}
      {sufijo && <span className="tabular-nums">· {sufijo}</span>}
    </span>
  );
}
