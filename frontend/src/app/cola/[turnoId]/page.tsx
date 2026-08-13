"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { BarraProgreso } from "@/components/BarraProgreso";
import { confirmarTurno } from "@/lib/api";
import { formatearTimer } from "@/hooks/useEstadoSilla";
import { useEstadoTurno } from "@/hooks/useEstadoTurno";

function formatearVentana(segundos: number | null): string {
  if (segundos === null) return "--:--";
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function EstadoTurno({
  params,
}: {
  params: Promise<{ turnoId: string }>;
}) {
  const { turnoId } = use(params);
  const { turno, segundosVentana, segundosSesion, error } = useEstadoTurno(turnoId, 3000);
  const [confirmando, setConfirmando] = useState(false);
  const [errorConfirmar, setErrorConfirmar] = useState<string | null>(null);

  // Una vez que el turno termina (para bien o para mal), dejamos de mandar
  // a este cliente para acá cuando vuelva a escanear cualquier QR.
  useEffect(() => {
    if (turno?.estado === "COMPLETADA" || turno?.estado === "CANCELADA") {
      const guardado = sessionStorage.getItem("turnoPendiente");
      if (guardado === turnoId) sessionStorage.removeItem("turnoPendiente");
    }
  }, [turno?.estado, turnoId]);

  async function confirmar() {
    setConfirmando(true);
    setErrorConfirmar(null);
    try {
      await confirmarTurno(turnoId);
    } catch (e) {
      setErrorConfirmar(
        e instanceof Error ? e.message : "No se pudo confirmar, avisá al encargado",
      );
      setConfirmando(false);
    }
  }

  if (error && !turno) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
        <p className="text-lg font-medium">No pudimos conectar</p>
        <p className="mt-2 text-sm text-tinta-muted">
          Revisá tu conexión e intentá de nuevo en unos segundos.
        </p>
      </main>
    );
  }

  if (!turno) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6">
        <p className="animate-pulse text-sm text-tinta-muted">Cargando…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="text-xs uppercase tracking-[0.12em] text-tinta-muted">Tu turno</p>
      {turno.codigo && (
        <p className="mt-1.5 text-4xl font-medium tabular-nums">{turno.codigo}</p>
      )}

      {turno.estado === "ESPERANDO_PAGO" && (
        <p className="mt-6 animate-pulse text-sm text-tinta-suave">
          Confirmando tu pago…
        </p>
      )}

      {turno.estado === "EN_COLA" && (
        <>
          <div className="mt-6 rounded-2xl border border-borde bg-marfil p-6">
            <p className="text-[13px] text-tinta-muted">Personas antes que vos</p>
            <p className="mt-1.5 text-[40px] font-medium leading-none tabular-nums">
              {turno.posicion ?? "–"}
            </p>
            <p className="mt-2 text-sm text-tinta-suave">
              {turno.sillasLibres === 0
                ? "Todas las sillas están ocupadas"
                : `${turno.sillasLibres} silla(s) libre(s) ahora`}
            </p>
          </div>
          <p className="mt-4 text-sm text-tinta-suave">
            Dejá esta pantalla abierta — te avisamos acá apenas te toque.
          </p>
        </>
      )}

      {turno.estado === "ASIGNADO" && (
        <>
          <div className="mt-6 rounded-2xl border border-terracota bg-terracota-claro p-6">
            <p className="text-[15px] font-medium text-terracota-oscuro">
              ¡Te toca {turno.sillaAsignada?.nombre ?? "tu silla"}!
            </p>
            <p className="mt-2 text-sm text-terracota-oscuro">
              Confirmá antes de que se acabe el tiempo, o pasás al siguiente.
            </p>
            <p className="mt-3 text-[44px] font-medium leading-none tabular-nums text-terracota-oscuro">
              {formatearVentana(segundosVentana)}
            </p>
          </div>
          <button
            onClick={confirmar}
            disabled={confirmando}
            className="mt-4 w-full rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
          >
            {confirmando ? "Confirmando…" : "Ya estoy, confirmar"}
          </button>
          {errorConfirmar && (
            <p className="mt-3 text-center text-sm text-terracota-oscuro">{errorConfirmar}</p>
          )}
        </>
      )}

      {turno.estado === "EN_USO" && (
        <>
          <p className="mt-2 text-sm text-tinta-suave">
            {turno.sillaAsignada?.nombre ?? "Tu silla"} está encendida. Disfrutá.
          </p>
          <div className="mt-6 w-full rounded-2xl border border-borde bg-marfil p-7 text-center">
            <p className="text-[13px] text-tinta-muted">Tiempo restante</p>
            <p className="mt-2 text-[52px] font-medium leading-none tabular-nums">
              {formatearTimer(segundosSesion)}
            </p>
            <div className="mt-5">
              <BarraProgreso
                restante={segundosSesion}
                totalSegundos={turno.duracionMin * 60}
              />
            </div>
          </div>
        </>
      )}

      {turno.estado === "COMPLETADA" && (
        <p className="mt-6 text-sm text-tinta-suave">
          Terminó tu sesión. ¡Gracias por venir!
        </p>
      )}

      {turno.estado === "CANCELADA" && (
        <>
          <p className="mt-6 text-sm text-tinta-suave">
            Tu turno se canceló (no llegaste a confirmar a tiempo, o venció la
            espera del pago).
          </p>
          <Link
            href="/"
            className="mt-6 text-sm text-tinta-muted underline underline-offset-4"
          >
            Volver a empezar
          </Link>
        </>
      )}
    </main>
  );
}
