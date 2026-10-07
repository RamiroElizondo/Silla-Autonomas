"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { AvisoCorte } from "@/components/AvisoCorte";
import { AvisoFaseSilla } from "@/components/AvisoFaseSilla";
import { SesionEnCurso } from "@/components/SesionEnCurso";
import { TarjetaCredito } from "@/components/TarjetaCredito";
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
  const { turno, segundosVentana, segundosSesion, segundosProximaSilla, segundosSalida, error } =
    useEstadoTurno(turnoId, 3000);
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

  const [hrefReintento, setHrefReintento] = useState("/");
  useEffect(() => {
    const sillaOrigen = sessionStorage.getItem(`sillaOrigen:${turnoId}`);
    if (sillaOrigen) setHrefReintento(`/silla/${sillaOrigen}`);
  }, [turnoId]);

  // Al terminar, el link vuelve al sillón que usó (donde puede pagar otro
  // turno); si no lo sabemos, al sillón donde entró a la cola.
  const hrefSillon = turno?.sillaAsignada
    ? `/silla/${turno.sillaAsignada.id}`
    : hrefReintento;

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
          {turno.posicion === 0 ? (
            <div className="mt-6 w-full rounded-2xl border border-borde bg-marfil p-6">
              <p className="text-xl font-medium">¡Sos el siguiente!</p>
              <p className="mt-2 text-sm text-tinta-suave">
                {turno.sillasLibres === 0
                  ? "Apenas se libere un sillón, te toca a vos."
                  : "Ya hay un sillón libre, te lo estamos asignando."}
              </p>
            </div>
          ) : (
            <div className="mt-6 w-full rounded-2xl border border-borde bg-marfil p-6">
              <p className="text-[13px] text-tinta-muted">
                {turno.posicion === 1 ? "Hay una persona antes que vos" : "Personas antes que vos"}
              </p>
              {turno.posicion !== 1 && (
                <p className="mt-1.5 text-[40px] font-medium leading-none tabular-nums">
                  {turno.posicion ?? "–"}
                </p>
              )}
              <p className="mt-2 text-sm text-tinta-suave">
                {turno.sillasLibres === 0
                  ? "Todos los sillones están ocupados"
                  : `${turno.sillasLibres} sillón(es) libre(s) ahora`}
              </p>
            </div>
          )}
          {turno.sillasLibres === 0 && segundosProximaSilla !== null && (
            <div className="mt-4 w-full rounded-2xl border border-borde bg-marfil p-5">
              <p className="text-[13px] text-tinta-muted">
                Sillón en uso. Tiempo restante
              </p>
              <p className="mt-1.5 text-[36px] font-medium leading-none tabular-nums">
                {formatearTimer(segundosProximaSilla)}
              </p>
            </div>
          )}
          <p className="mt-4 text-sm text-tinta-suave">
            Dejá esta pantalla abierta — te avisamos acá apenas te toque.
          </p>
        </>
      )}

      {turno.estado === "ASIGNADO" && (
        <>
          <div className="mt-6 rounded-2xl border border-terracota bg-terracota-claro p-6">
            <p className="text-[15px] font-medium text-terracota-oscuro">
              ¡Te toca {turno.sillaAsignada?.nombre ?? "tu sillón"}!
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

      {turno.estado === "EN_USO" && turno.interrumpida && <AvisoCorte />}

      {turno.estado === "EN_USO" && turno.sesionEstado === "ESPERANDO_ENERGIA" && (
        <div className="mt-6 w-full rounded-2xl border border-arena bg-panal p-6">
          <p className="text-[15px] font-medium">El sillón está sin luz</p>
          <p className="mt-2 text-sm text-tinta-suave">
            Tu turno sigue siendo tuyo. Lo encendemos automáticamente apenas vuelva la
            energía.
          </p>
        </div>
      )}

      {turno.estado === "EN_USO" &&
        !turno.interrumpida &&
        (turno.fase === "PAUSA" || turno.fase === "RETORNO") && (
          <>
            <p className="mt-2 text-sm text-tinta-suave">Terminó tu masaje</p>
            <AvisoFaseSilla fase={turno.fase} segundosSalida={segundosSalida} />
          </>
        )}

      {turno.estado === "EN_USO" &&
        !turno.interrumpida &&
        turno.sesionEstado !== "ESPERANDO_ENERGIA" &&
        turno.fase !== "PAUSA" &&
        turno.fase !== "RETORNO" && (
        <SesionEnCurso
          sillaNombre={turno.sillaAsignada?.nombre}
          segundos={segundosSesion}
          totalSegundos={turno.duracionMin * 60}
          fase={turno.fase}
        />
      )}

      {turno.estado === "COMPLETADA" && (
        <>
          <p className="mt-6 text-sm text-tinta-suave">
            Terminó tu sesión. ¡Gracias por venir!
          </p>
          <Link
            href={hrefSillon}
            className="mt-8 text-sm text-tinta-muted underline underline-offset-4"
          >
            Ver estado del sillón
          </Link>
        </>
      )}

      {turno.estado === "CANCELADA" && turno.credito && (
        <TarjetaCredito
          credito={turno.credito}
          titulo="Se cortó la luz"
          detalle={`No perdés tu turno: te queda un vale por ${turno.credito.duracionMin} minutos.`}
        />
      )}

      {turno.estado === "CANCELADA" && !turno.credito && (
        <>
          <p className="mt-6 text-sm text-tinta-suave">
            Tu turno se canceló (no llegaste a confirmar a tiempo, o venció la
            espera del pago).
          </p>
          <Link
            href={hrefReintento}
            className="mt-6 text-sm text-tinta-muted underline underline-offset-4"
          >
            Volver a empezar
          </Link>
        </>
      )}
    </main>
  );
}
