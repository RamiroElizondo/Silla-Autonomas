"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EstadoBadge } from "@/components/EstadoBadge";
import { BarraProgreso } from "@/components/BarraProgreso";
import { FormCodigoCredito } from "@/components/FormCodigoCredito";
import { TurnstileWidget } from "@/components/TurnstileWidget";
import { formatearTimer, useEstadoSilla } from "@/hooks/useEstadoSilla";
import { iniciarCheckout, obtenerResumenCola, unirseCola } from "@/lib/api";
import { debeSondearAhora } from "@/lib/polling";
import type { ColaResumen } from "@/lib/tipos";

const TURNSTILE_REQUERIDO = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

export default function LandingSilla({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [chequeandoTurno, setChequeandoTurno] = useState(true);
  const { estado, segundos, segundosSalida, error } = useEstadoSilla(id, 5000);
  const [pagando, setPagando] = useState(false);
  const [errorPago, setErrorPago] = useState<string | null>(null);
  const [cola, setCola] = useState<ColaResumen | null>(null);
  const [uniendose, setUniendose] = useState(false);
  const [errorCola, setErrorCola] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

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
  // Sin energía la silla figura libre en la base pero no puede encender. No
  // ofrecemos pagarla: cobrar y no poder entregar es peor que no vender.
  const sinEnergia = estado?.sinEnergia === true && estado.estado !== "FUERA_DE_SERVICIO";
  const sePuedePagarAca = estado?.estado === "LIBRE" && !sinEnergia;
  const mostrarCola = Boolean(ocupada) || sinEnergia;

  // Cuando esta silla puntual no está disponible, mostramos cuánta gente
  // espera en la cola compartida — se puede pagar igual y te asignamos la
  // primera silla que se libere (no necesariamente esta).
  useEffect(() => {
    if (!mostrarCola) return;
    let cancelado = false;

    async function cargar() {
      // Mismo criterio de pausa-en-oculto que los hooks de useEstado* (ver
      // su comentario): no tiene sentido sondear la cola si nadie está
      // mirando esta pestaña en este momento.
      const oculto = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (!debeSondearAhora({ oculto, pausarEnOculto: true })) return;
      try {
        const data = await obtenerResumenCola();
        if (!cancelado) setCola(data);
      } catch {
        // silencioso: no bloquea la vista principal
      }
    }

    function alCambiarVisibilidad() {
      if (document.visibilityState === "visible") cargar();
    }

    cargar();
    const intervalo = setInterval(cargar, 5000);
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    return () => {
      cancelado = true;
      clearInterval(intervalo);
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
    };
  }, [mostrarCola]);

  async function pagar() {
    setPagando(true);
    setErrorPago(null);
    try {
      const { sesionId, initPoint } = await iniciarCheckout(id, turnstileToken);
      // Lo guardamos para que /fracaso pueda liberar la silla al toque si
      // el cliente cancela, y para que /exito pueda seguir ESTA sesión
      // (cortes de luz, vales) y no el estado general de la silla.
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
      const { turnoId, initPoint } = await unirseCola(turnstileToken);
      sessionStorage.setItem(`turnoPendiente`, turnoId);
      // Recordamos desde qué silla (QR) arrancó, para que si se arrepiente en
      // Mercado Pago el "Volver a empezar" lo traiga de vuelta acá.
      sessionStorage.setItem(`sillaOrigen:${turnoId}`, id);
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
        Relajá · San Juan
      </p>
      <h1 className="mt-1.5 text-3xl font-medium">{estado.nombre}</h1>
      <div className="mt-3.5">
        <EstadoBadge
          estado={estado.estado}
          sinEnergia={sinEnergia}
        />
      </div>

      {sinEnergia && (
        <div className="mt-6 rounded-2xl border border-arena bg-panal p-6 text-center">
          <p className="text-[15px] font-medium">Este sillón está sin conexión</p>
          <p className="mt-2 text-sm text-tinta-suave">
            Puede ser un corte de luz en el local. No te lo cobramos hasta que
            podamos encenderlo.
          </p>
          <p className="mt-3 text-xs text-arena">
            Esta pantalla se actualiza sola cuando vuelve
          </p>
        </div>
      )}

      {sePuedePagarAca && (
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
          <TurnstileWidget onToken={setTurnstileToken} />
          <button
            onClick={pagar}
            disabled={pagando || (TURNSTILE_REQUERIDO && !turnstileToken)}
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
            El sillón se enciende solo al confirmarse el pago
          </p>
        </>
      )}

      {estado.estado === "EN_USO" &&
        !sinEnergia &&
        (estado.fase === "PAUSA" || estado.fase === "RETORNO") && (
          <div className="mt-6 rounded-2xl border border-borde bg-marfil p-7 text-center">
            <p className="text-[15px] font-medium">El sillón se está liberando</p>
            <p className="mt-2 text-sm text-tinta-muted">
              La persona anterior está terminando de bajarse. Queda libre en{" "}
              <span className="tabular-nums">{segundosSalida ?? 0}s</span>.
            </p>
          </div>
        )}

      {estado.estado === "EN_USO" &&
        !sinEnergia &&
        estado.fase !== "PAUSA" &&
        estado.fase !== "RETORNO" && (
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
        </>
      )}

      {(estado.estado === "PAGO_PENDIENTE" || estado.estado === "RESERVADA") &&
        !sinEnergia && (
          <div className="mt-6 rounded-2xl border border-borde bg-marfil p-6 text-center">
            <p className="text-[15px] font-medium">Este sillón está reservado</p>
            <p className="mt-2 text-sm text-tinta-muted">
              Alguien está por usarlo. Si no se confirma en unos minutos, vuelve
              a quedar libre.
            </p>
          </div>
        )}

      {mostrarCola && (
        <>
          <div className="mt-4 rounded-2xl border border-borde bg-marfil p-6 text-center">
            <p className="text-[15px] font-medium">
              {cola && cola.sillasLibres > 0
                ? "Hay otro sillón libre"
                : "Pagá y esperá tu turno"}
            </p>
            <p className="mt-2 text-sm text-tinta-muted">
              {cola
                ? cola.enCola > 0
                  ? `${cola.enCola} persona(s) esperando · ${cola.sillasLibres} de ${cola.sillasTotal} sillón(es) libre(s)`
                  : `${cola.sillasLibres} de ${cola.sillasTotal} sillón(es) libre(s)`
                : "Te anotamos y te avisamos apenas se libere un sillón."}
            </p>
          </div>
          <TurnstileWidget onToken={setTurnstileToken} />
          <button
            onClick={unirmeACola}
            disabled={uniendose || (TURNSTILE_REQUERIDO && !turnstileToken)}
            className="mt-4 w-full rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
          >
            {uniendose ? "Conectando con Mercado Pago…" : "Pagar y esperar mi turno"}
          </button>
          {errorCola && (
            <p className="mt-3 text-center text-sm text-terracota-oscuro">{errorCola}</p>
          )}
          <p className="mt-3 text-center text-xs text-tinta-muted">
            Te asignamos el primer sillón que se libere, no necesariamente este
          </p>
        </>
      )}

      {estado.estado === "FUERA_DE_SERVICIO" && (
        <div className="mt-6 rounded-2xl border border-borde bg-marfil p-6 text-center">
          <p className="text-[15px] font-medium">Sillón en mantenimiento</p>
          <p className="mt-2 text-sm text-tinta-muted">
            Disculpá las molestias, pronto vuelve a estar disponible.
          </p>
        </div>
      )}

      <FormCodigoCredito />
    </main>
  );
}
