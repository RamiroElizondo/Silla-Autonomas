import type { EstadoSilla } from "@/lib/tipos";

const config: Record<
  EstadoSilla,
  { texto: string; fondo: string; texto_color: string; punto: string }
> = {
  LIBRE: {
    texto: "Libre ahora",
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

export function EstadoBadge({
  estado,
  sufijo,
}: {
  estado: EstadoSilla;
  sufijo?: string;
}) {
  const c = config[estado];
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
