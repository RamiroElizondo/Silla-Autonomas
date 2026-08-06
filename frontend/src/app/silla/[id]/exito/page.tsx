"use client";

import { use } from "react";
import Link from "next/link";
import { formatearTimer, useEstadoSilla } from "@/hooks/useEstadoSilla";

export default function Exito({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  // Sondeo rápido: el webhook puede tardar unos segundos en activar la silla
  const { estado, segundos } = useEstadoSilla(id, 2000);
  const activa = estado?.estado === "EN_USO";

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

      {activa ? (
        <>
          <p className="mt-2 text-sm text-tinta-suave">
            Tu silla ya está encendida. Sentate y disfrutá.
          </p>
          <p className="mt-6 text-[44px] font-medium leading-none tabular-nums">
            {formatearTimer(segundos)}
          </p>
          <p className="mt-2 text-xs text-tinta-muted">de masaje por delante</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-tinta-suave">
          Estamos encendiendo tu silla, tardará unos segundos…
        </p>
      )}

      <Link
        href={`/silla/${id}`}
        className="mt-8 text-sm text-tinta-muted underline underline-offset-4"
      >
        Ver estado de la silla
      </Link>
    </main>
  );
}
