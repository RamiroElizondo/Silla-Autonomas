import type { FaseTurno } from "@/lib/tipos";
import { formatearTimer } from "@/hooks/useEstadoSilla";
import { AvisoFaseSilla } from "./AvisoFaseSilla";
import { BarraProgreso } from "./BarraProgreso";

/**
 * Lo que ve el cliente mientras su sillón está encendido. Es el mismo bloque
 * para el pago directo (`/silla/[id]/exito`) y para quien entró por la cola
 * (`/cola/[turnoId]`): aviso de "encendido", reloj en tarjeta blanca y,
 * debajo, las indicaciones del control cuando corresponden.
 */
export function SesionEnCurso({
  sillaNombre,
  segundos,
  totalSegundos,
  fase,
  nota,
}: {
  sillaNombre: string | null | undefined;
  segundos: number | null;
  totalSegundos: number;
  fase: FaseTurno | null | undefined;
  /** Línea chica bajo la tarjeta (ej. tiempo devuelto por cortes). */
  nota?: string;
}) {
  return (
    <>
      <p className="mt-3 text-lg font-medium text-tinta">
        {sillaNombre ?? "Tu sillón"} está encendido. Disfrutá.
      </p>
      <div className="mt-6 w-full rounded-2xl border border-borde bg-marfil p-7 text-center">
        <p className="text-[13px] text-tinta-muted">Tiempo restante</p>
        <p className="mt-2 text-[52px] font-medium leading-none tabular-nums">
          {formatearTimer(segundos)}
        </p>
        {totalSegundos > 0 && (
          <div className="mt-5">
            <BarraProgreso restante={segundos} totalSegundos={totalSegundos} />
          </div>
        )}
      </div>
      {nota && <p className="mt-3 text-xs text-tinta-muted">{nota}</p>}
      <AvisoFaseSilla fase={fase} />
    </>
  );
}
