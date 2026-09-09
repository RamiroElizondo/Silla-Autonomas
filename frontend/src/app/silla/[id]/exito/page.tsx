"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { formatearTimer, useEstadoSilla } from "@/hooks/useEstadoSilla";
import { confirmarPagoRetorno } from "@/lib/api";

export default function Exito({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [errorConfirmacion, setErrorConfirmacion] = useState<string | null>(null);
  // Sondeo rápido: el Webhook o el retorno verificado activarán la silla.
  const { estado, segundos } = useEstadoSilla(id, 2000);
  const activa = estado?.estado === "EN_USO";

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const paymentId = query.get("payment_id") ?? query.get("collection_id");
    if (!paymentId) {
      setErrorConfirmacion("Mercado Pago no devolvió el identificador del pago.");
      return;
    }

    let vigente = true;
    confirmarPagoRetorno(id, paymentId).catch((error) => {
      if (vigente) {
        setErrorConfirmacion(
          error instanceof Error ? error.message : "No se pudo verificar el pago.",
        );
      }
    });
    return () => {
      vigente = false;
    };
  }, [id]);

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
        {activa
          ? "¡Pago confirmado!"
          : errorConfirmacion
            ? "No pudimos confirmar el pago"
            : "Confirmando tu pago…"}
      </h1>

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
          {errorConfirmacion
            ? `${errorConfirmacion} Avisá al encargado y no vuelvas a pagar.`
            : "Estamos verificando el pago y encendiendo tu silla…"}
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
