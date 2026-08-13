"use client";

import { use } from "react";
import Link from "next/link";
import { useEstadoTurno } from "@/hooks/useEstadoTurno";

export default function Exito({
  params,
}: {
  params: Promise<{ turnoId: string }>;
}) {
  const { turnoId } = use(params);
  // Sondeo rápido: el webhook puede tardar unos segundos en anotarte en la cola
  const { turno } = useEstadoTurno(turnoId, 2000);
  const enCola = turno && turno.estado !== "ESPERANDO_PAGO";

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
      <h1 className="mt-5 text-2xl font-medium">¡Pago confirmado!</h1>
      <p className="mt-2 text-sm text-tinta-suave">
        {enCola
          ? "Ya estás anotado en la cola. Te avisamos apenas te toque."
          : "Estamos anotándote en la cola, tardará unos segundos…"}
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
