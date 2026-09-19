"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { canjearCredito } from "@/lib/api";
import type { CreditoPublico } from "@/lib/tipos";

/**
 * Vale por el tiempo que quedó sin prestar. El botón es el que confirma que
 * el cliente sigue en el local: por eso no le preguntamos nada antes de
 * emitirlo — si ya se fue, no lo canjea y el vale vence solo.
 */
export function TarjetaCredito({
  credito,
  titulo = "Se cortó la luz",
  detalle,
}: {
  credito: CreditoPublico;
  titulo?: string;
  detalle?: string;
}) {
  const router = useRouter();
  const [canjeando, setCanjeando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yaUsado = credito.estado !== "DISPONIBLE";

  async function reclamar() {
    setCanjeando(true);
    setError(null);
    try {
      const { turnoId } = await canjearCredito(credito.codigo);
      sessionStorage.setItem("turnoPendiente", turnoId);
      router.push(`/cola/${turnoId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo reclamar el turno");
      setCanjeando(false);
    }
  }

  return (
    <div className="mt-6 w-full rounded-2xl border border-borde bg-marfil p-6 text-center">
      <p className="text-[15px] font-medium">{titulo}</p>
      <p className="mt-2 text-sm text-tinta-muted">
        {detalle ??
          `No te cobramos de nuevo: te queda un vale por ${credito.duracionMin} minutos.`}
      </p>

      <p className="mt-5 text-xs uppercase tracking-[0.12em] text-tinta-muted">
        Tu código
      </p>
      <p className="mt-1 text-4xl font-medium tabular-nums">{credito.codigo}</p>

      {yaUsado ? (
        <p className="mt-4 text-sm text-tinta-suave">
          Este vale ya fue {credito.estado === "CANJEADO" ? "usado" : "vencido"}.
        </p>
      ) : (
        <>
          <button
            onClick={reclamar}
            disabled={canjeando}
            className="mt-5 w-full rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
          >
            {canjeando ? "Reclamando…" : "Reclamar mi turno"}
          </button>
          {error && (
            <p className="mt-3 text-sm text-terracota-oscuro">{error}</p>
          )}
          <p className="mt-3 text-xs text-arena">
            Anotá el código: si te vas, podés usarlo hasta el{" "}
            {new Date(credito.venceEn).toLocaleDateString("es-AR")}
          </p>
        </>
      )}
    </div>
  );
}
