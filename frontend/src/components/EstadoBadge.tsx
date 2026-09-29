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
    texto: "Reservada",
    fondo: "bg-panal",
    texto_color: "text-tinta-suave",
    punto: "bg-arena",
  },
  RESERVADA: {
    texto: "Reservada",
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
}: {
  estado: EstadoSilla;
  sufijo?: string;
  sinEnergia?: boolean;
}) {
  const c = sinEnergia && estado !== "FUERA_DE_SERVICIO" ? SIN_ENERGIA : config[estado];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium ${c.fondo} ${c.texto_color}`}
    >
      <span className={`h-2 w-2 rounded-full ${c.punto}`} />
      {c.texto}
      {sufijo && <span className="tabular-nums">· {sufijo}</span>}
    </span>
  );
}
