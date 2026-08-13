"use client";

import { use, useEffect } from "react";
import Link from "next/link";
import { cancelarTurno } from "@/lib/api";

export default function Fracaso({
  params,
}: {
  params: Promise<{ turnoId: string }>;
}) {
  const { turnoId } = use(params);

  useEffect(() => {
    // El cliente canceló o el pago fue rechazado: liberamos el lugar en la
    // cola ya mismo en vez de dejarlo "ESPERANDO_PAGO" hasta el timeout.
    cancelarTurno(turnoId).catch(() => {});
  }, [turnoId]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-terracota-claro">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="#7A3B26"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <h1 className="mt-5 text-2xl font-medium">El pago no se completó</h1>
      <p className="mt-2 text-sm text-tinta-suave">
        No se realizó ningún cargo. Podés intentarlo de nuevo cuando quieras.
      </p>
      <Link
        href="/"
        className="mt-8 w-full max-w-xs rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover"
      >
        Volver a empezar
      </Link>
    </main>
  );
}
