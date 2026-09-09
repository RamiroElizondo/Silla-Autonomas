"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useEstadoTurno } from "@/hooks/useEstadoTurno";
import { confirmarPagoTurnoRetorno } from "@/lib/api";

export default function Exito({
  params,
}: {
  params: Promise<{ turnoId: string }>;
}) {
  const { turnoId } = use(params);
  const [errorConfirmacion, setErrorConfirmacion] = useState<string | null>(null);
  // Sondeo rápido: el Webhook o el retorno verificado anotarán el turno.
  const { turno } = useEstadoTurno(turnoId, 2000);
  const enCola = turno && turno.estado !== "ESPERANDO_PAGO";

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const paymentId = query.get("payment_id") ?? query.get("collection_id");
    if (!paymentId) {
      setErrorConfirmacion("Mercado Pago no devolvió el identificador del pago.");
      return;
    }

    let vigente = true;
    confirmarPagoTurnoRetorno(turnoId, paymentId).catch((error) => {
      if (vigente) {
        setErrorConfirmacion(
          error instanceof Error ? error.message : "No se pudo verificar el pago.",
        );
      }
    });
    return () => {
      vigente = false;
    };
  }, [turnoId]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-salvia-claro">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 13l4 4L19 7"
            stroke="#46543C"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h1 className="mt-5 text-2xl font-medium">
        {enCola
          ? "¡Pago confirmado!"
          : errorConfirmacion
            ? "No pudimos confirmar el pago"
            : "Confirmando tu pago…"}
      </h1>
      <p className="mt-2 text-sm text-tinta-suave">
        {errorConfirmacion
          ? `${errorConfirmacion} Avisá al encargado y no vuelvas a pagar.`
          : enCola
            ? "Ya estás anotado en la cola. Te avisamos apenas te toque."
            : "Estamos verificando el pago y anotándote en la cola…"}
      </p>

      <Link
        href={`/cola/${turnoId}`}
        className="mt-8 w-full max-w-xs rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover"
      >
        Ver mi turno
      </Link>
    </main>
  );
}
