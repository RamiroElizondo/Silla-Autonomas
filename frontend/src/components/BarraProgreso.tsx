/** Barra de progreso del masaje: fracción restante sobre el total. */
export function BarraProgreso({
  restante,
  totalSegundos,
  claseFondo = "bg-pista",
  claseRelleno = "bg-salvia",
}: {
  restante: number | null;
  totalSegundos: number;
  claseFondo?: string;
  claseRelleno?: string;
}) {
  const pct =
    restante === null || totalSegundos <= 0
      ? 0
      : Math.max(0, Math.min(100, (restante / totalSegundos) * 100));
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full ${claseFondo}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${claseRelleno}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
