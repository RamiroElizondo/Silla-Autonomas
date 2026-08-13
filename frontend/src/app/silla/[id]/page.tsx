"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EstadoBadge } from "@/components/EstadoBadge";
import { BarraProgreso } from "@/components/BarraProgreso";
import { formatearTimer, useEstadoSilla } from "@/hooks/useEstadoSilla";
import { iniciarCheckout, obtenerResumenCola, unirseCola } from "@/lib/api";
import type { ColaResumen } from "@/lib/tipos";

export default function LandingSilla({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [chequeandoTurno, setChequeandoTurno] = useState(true);
  const { estado, segundos, error } = useEstadoSilla(id, 5000);
  const [pagando, setPagando] = useState(false);
  const [errorPago, setErrorPago] = useState<string | null>(null);
  const [cola, setCola] = useState<ColaResumen | null>(null);
  const [uniendose, setUniendose] = useState(false);
  const [errorCola, setErrorCola] = useState<string | null>(null);

  // Si ya tenés un turno en curso (pagaste y estás esperando/confirmando),
  // te mandamos directo ahí en vez de mostrar esta vista genérica — pasa
  // seguido que la gente vuelve a escanear el QR de cualquier silla para
  // "ver cómo va" en vez de guardar el link de su turno.
  useEffect(() => {
    const turnoPendiente = sessionStorage.getItem("turnoPendiente");
    if (turnoPendiente) {
      router.replace(`/cola/${turnoPendiente}`);
      return;
    }
    setChequeandoTurno(false);
  }, [router]);

  const ocupada = estado && estado.estado !== "LIBRE" && estado.estado !== "FUERA_DE_SERVICIO";

  // Cuando esta silla puntual no está libre, mostramos cuánta gente espera
  // en la cola compartida — se puede pagar igual y te asignamos la primera
  // silla que se libere (no necesariamente esta).
  useEffect(() => {
    if (!ocupada) return;
    let cancelado = false;
    async function cargar() {
      try {
        const data = await obtenerResumenCola();
        if (!cancelado) setCola(data);
      } catch {
        // silencioso: no bloquea la vista principal
      }
    }
    cargar();
    const intervalo = setInterval(cargar, 5000);
    return () => {
      cancelado = true;
      clearInterval(intervalo);
    };
  }, [ocupada]);

  async function pagar() {
    setPagando(true);
    setErrorPago(null);
    try {
      const { sesionId, initPoint } = await iniciarCheckout(id);
      // Lo guardamos para que /fracaso pueda liberar la silla al toque si
      // el cliente cancela, en vez de esperar el timeout de 3 min.
      sessionStorage.setItem(`sesionPendiente:${id}`, sesionId);
      window.location.href = initPoint;
    } catch (e) {
      setErrorPago(e instanceof Error ? e.message : "No se pudo iniciar el pago");
      setPagando(false);
    }
  }

  async function unirmeACola() {
    setUniendose(true);
    setErrorCola(null);
    try {
      const { turnoId, initPoint } = await unirseCola();
      sessionStorage.setItem(`turnoPendiente`, turnoId);
      window.location.href = initPoint;
    } catch (e) {
      setErrorCola(e instanceof Error ? e.message : "No se pudo iniciar el pago");
      setUniendose(false);
    }
  }

  if (chequeandoTurno) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6">
        <p className="animate-pulse text-sm text-tinta-muted">Cargando…</p>
      </main>
    );
  }

  if (error && !estado) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
        <p className="text-lg font-medium">No pudimos conectar</p>
        <p className="mt-2 text-sm text-tinta-muted">
          Revisá tu conexión e intentá de nuevo en unos segundos.
        </p>
      </main>
    );
  }

  if (!estado) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6">
        <p className="animate-pulse text-sm text-tinta-muted">Cargando…</p>
      </main>
    );
  }

  const totalSegundos = estado.duracionMin * 60;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pb-10 pt-8">
      <p className="text-xs uppercase tracking-[0.12em] text-tinta-muted">
        Relax Point · San Juan
      </p>
      <h1 className="mt-1.5 text-3xl font-medium">{estado.nombre}</h1>
      <div className="mt-3.5">
        <EstadoBadge
          estado={estado.estado}
          sufijo={estado.estado === "EN_USO" ? formatearTimer(segundos) : undefined}
        />
      </div>

      {estado.estado === "LIBRE" && (
        <>
          <div className="mt-6 rounded-2xl border border-borde bg-marfil p-6">
            <p className="text-[13px] text-tinta-muted">Masaje completo</p>
            <p className="mt-1.5 text-[40px] font-medium leading-none">
              ${estado.precio.toLocaleString("es-AR")}
            </p>
            <p className="mt-2 text-sm text-tinta-suave">
              {estado.duracionMin} minutos
            </p>
          </div>
          <button
            onClick={pagar}
            disabled={pagando}
            className="mt-4 w-full rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
          >
            {pagando ? "Conectando con Mercado Pago…" : "Pagar y empezar"}
          </button>
          {errorPago && (
            <p className="mt-3 text-center text-sm text-terracota-oscuro">
              {errorPago}
            </p>
          )}
          <p className="mt-3 text-center text-xs text-tinta-muted">
            Pago seguro con Mercado Pago
          </p>
          <p className="mt-1.5 text-center text-xs text-arena">
            La silla se enciende sola al confirmarse el pago
          </p>
        </>
      )}

      {estado.estado === "EN_USO" && (
        <>
          <div className="mt-6 rounded-2xl border border-borde bg-marfil p-7 text-center">
            <p className="text-[13px] text-tinta-muted">Tiempo restante</p>
            <p className="mt-2 text-[52px] font-medium leading-none tabular-nums">
              {formatearTimer(segundos)}
            </p>
            <div className="mt-5">
              <BarraProgreso restante={segundos} totalSegundos={totalSegundos} />
            </div>
          </div>
          <div className="mt-4 rounded-xl bg-panal px-4 py-3.5 text-center text-[13px] text-tinta-suave">
            Se libera automáticamente al terminar
          </div>
          <p className="mt-3.5 text-center text-xs text-arena">
            Volvé a escanear el QR cuando esté libre
          </p>
        </>
      )}

      {(estado.estado === "PAGO_PENDIENTE" || estado.estado === "RESERVADA") && (
        <div className="mt-6 rounded-2xl border border-borde bg-marfil p-6 text-center">
          <p className="text-[15px] font-medium">Esta silla está reservada</p>
          <p className="mt-2 text-sm text-tinta-muted">
            Alguien está por usarla. Si no se confirma en unos minutos, vuelve
            a quedar libre.
          </p>
        </div>
      )}

      {ocupada && (
        <>
          <div className="mt-4 rounded-2xl border border-borde bg-marfil p-6 text-center">
            <p className="text-[15px] font-medium">
              {cola && cola.sillasLibres > 0
                ? "Hay otra silla libre"
                : "Pagá y esperá tu turno"}
            </p>
            <p className="mt-2 text-sm text-tinta-muted">
              {cola
                ? cola.enCola > 0
                  ? `${cola.enCola} persona(s) esperando · ${cola.sillasLibres} de ${cola.sillasTotal} silla(s) libre(s)`
                  : `${cola.sillasLibres} de ${cola.sillasTotal} silla(s) libre(s)`
                : "Te anotamos y te avisamos apenas se libere una silla."}
            </p>
          </div>
          <button
            onClick={unirmeACola}
            disabled={uniendose}
            className="mt-4 w-full rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
          >
            {uniendose ? "Conectando con Mercado Pago…" : "Pagar y esperar mi turno"}
          </button>
          {errorCola && (
            <p className="mt-3 text-center text-sm text-terracota-oscuro">{errorCola}</p>
          )}
          <p className="mt-3 text-center text-xs text-tinta-muted">
            Te asignamos la primera silla que se libere, no necesariamente esta
          </p>
        </>
      )}

      {estado.estado === "FUERA_DE_SERVICIO" && (
        <div className="mt-6 rounded-2xl border border-borde bg-marfil p-6 text-center">
          <p className="text-[15px] font-medium">Silla en mantenimiento</p>
          <p className="mt-2 text-sm text-tinta-muted">
            Disculpá las molestias, pronto vuelve a estar disponible.
          </p>
        </div>
      )}
    </main>
  );
}
