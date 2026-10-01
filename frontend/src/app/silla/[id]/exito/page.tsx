"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { AvisoCorte } from "@/components/AvisoCorte";
import { AvisoFaseSilla } from "@/components/AvisoFaseSilla";
import { BarraProgreso } from "@/components/BarraProgreso";
import { TarjetaCredito } from "@/components/TarjetaCredito";
import { formatearTimer, useEstadoSilla } from "@/hooks/useEstadoSilla";
import { formatearDevuelto, useEstadoSesion } from "@/hooks/useEstadoSesion";
import { confirmarPagoRetorno, confirmarSesion } from "@/lib/api";

export default function Exito({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [errorConfirmacion, setErrorConfirmacion] = useState<string | null>(null);
  const [sesionId, setSesionId] = useState<string | null>(null);

  // El id de la sesión lo guardó la landing antes de mandarnos a Mercado
  // Pago. Es lo que nos deja seguir ESTA sesión y no el estado general de la
  // silla — que después de un corte puede estar libre para otra persona.
  useEffect(() => {
    setSesionId(
      new URLSearchParams(window.location.search).get("sesion") ??
        sessionStorage.getItem(`sesionPendiente:${id}`),
    );
  }, [id]);

  const { sesion, segundos, segundosVentana, segundosSalida, refrescar } = useEstadoSesion(
    sesionId,
    3000,
  );
  const [confirmando, setConfirmando] = useState(false);
  const [errorSentarse, setErrorSentarse] = useState<string | null>(null);
  // Respaldo para cuando no tenemos el id (ej. el cliente abrió el link de
  // vuelta en otro navegador): al menos mostramos el estado de la silla.
  const {
    estado: silla,
    segundos: segundosSilla,
    segundosSalida: segundosSalidaSilla,
  } = useEstadoSilla(id, 3000);

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

  // La sesión terminó: dejamos de arrastrar su id para el próximo escaneo.
  useEffect(() => {
    if (sesion?.estado === "COMPLETADA" || sesion?.estado === "CANCELADA") {
      sessionStorage.removeItem(`sesionPendiente:${id}`);
    }
  }, [sesion?.estado, id]);

  async function confirmar() {
    if (!sesionId) return;
    setConfirmando(true);
    setErrorSentarse(null);
    try {
      await confirmarSesion(sesionId);
      await refrescar();
    } catch (e) {
      setErrorSentarse(
        e instanceof Error ? e.message : "No se pudo confirmar, avisá al encargado",
      );
    } finally {
      setConfirmando(false);
    }
  }

  const esperandoConfirmacion = sesion?.estado === "ESPERANDO_CONFIRMACION";
  const enCurso = sesion?.estado === "ACTIVA" && !sesion.interrumpida;
  const interrumpida = sesion?.estado === "ACTIVA" && sesion.interrumpida;
  const esperandoEnergia = sesion?.estado === "ESPERANDO_ENERGIA";
  // Fase SALIDA: terminó el tiempo y la silla hace el pulso de retorno.
  const enSalida = sesion?.estado === "SALIDA";
  const activaSinSesion = !sesion && silla?.estado === "EN_USO";
  const faseSilla = activaSinSesion ? (silla?.fase ?? null) : null;
  const salidaSinSesion = faseSilla === "PAUSA" || faseSilla === "RETORNO";
  // Sesión cancelada SIN vale (con vale se muestra la tarjeta de crédito).
  // Ej.: parada de emergencia del encargado, o el pago nunca llegó.
  const cancelada = sesion?.estado === "CANCELADA" && !sesion.credito;
  const detenidaPorEncargado = cancelada && sesion?.motivoCierre === "parada_de_emergencia";

  const titulo = (() => {
    if (esperandoConfirmacion) return "¡Pago confirmado!";
    if (esperandoEnergia) return "Pago confirmado";
    if (interrumpida) return "Tu masaje está en pausa";
    if (sesion?.credito) return "Te debemos un turno";
    if (sesion?.estado === "COMPLETADA" || enSalida || salidaSinSesion) return "Terminó tu masaje";
    if (detenidaPorEncargado) return "Se detuvo tu masaje";
    if (cancelada) return "Se canceló tu sesión";
    if (enCurso || activaSinSesion) return "¡Pago confirmado!";
    if (errorConfirmacion) return "No pudimos confirmar el pago";
    return "Confirmando tu pago…";
  })();

  const timer = sesion ? segundos : segundosSilla;
  const total = (sesion?.duracionMin ?? silla?.duracionMin ?? 0) * 60;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-salvia-claro">
        {cancelada ? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9 6v12M15 6v12"
              stroke="#46543C"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M5 13l4 4L19 7"
              stroke="#46543C"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <h1 className="mt-5 text-2xl font-medium">{titulo}</h1>

      {esperandoConfirmacion && (
        <>
          <div className="mt-6 w-full rounded-2xl border border-terracota bg-terracota-claro p-6">
            <p className="text-[15px] font-medium text-terracota-oscuro">
              Sentate en {sesion?.sillaNombre ?? "tu silla"} y confirmá
            </p>
            <p className="mt-2 text-sm text-terracota-oscuro">
              La encendemos cuando toques el botón. Si no confirmás a tiempo, la
              silla se libera.
            </p>
            <p className="mt-3 text-[44px] font-medium leading-none tabular-nums text-terracota-oscuro">
              {formatearTimer(segundosVentana)}
            </p>
          </div>
          <button
            onClick={confirmar}
            disabled={confirmando}
            className="mt-4 w-full rounded-xl bg-terracota py-4 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
          >
            {confirmando ? "Confirmando…" : "Ya estoy, confirmar"}
          </button>
          {errorSentarse && (
            <p className="mt-3 text-center text-sm text-terracota-oscuro">{errorSentarse}</p>
          )}
        </>
      )}

      {(enSalida || salidaSinSesion) && (
        <AvisoFaseSilla
          fase={enSalida ? sesion?.fase : faseSilla}
          segundosSalida={enSalida ? segundosSalida : segundosSalidaSilla}
        />
      )}

      {(enCurso || (activaSinSesion && !salidaSinSesion)) && (
        <>
          <p className="mt-2 text-sm text-tinta-suave">
            Tu silla ya está encendida. Sentate y disfrutá.
          </p>
          <AvisoFaseSilla fase={sesion ? sesion.fase : faseSilla} />
          <p className="mt-6 text-[44px] font-medium leading-none tabular-nums">
            {formatearTimer(timer)}
          </p>
          <p className="mt-2 text-xs text-tinta-muted">de masaje por delante</p>
          {total > 0 && (
            <div className="mt-5 w-full">
              <BarraProgreso restante={timer} totalSegundos={total} />
            </div>
          )}
          {sesion && sesion.segundosCompensados > 0 && (
            <p className="mt-4 text-xs text-tinta-muted">
              Hubo {sesion.cortes === 1 ? "un corte de luz" : `${sesion.cortes} cortes de luz`}
              : te devolvimos {formatearDevuelto(sesion.segundosCompensados)}
            </p>
          )}
        </>
      )}

      {interrumpida && (
        <AvisoCorte
          compensados={
            sesion && sesion.segundosCompensados > 0
              ? formatearDevuelto(sesion.segundosCompensados)
              : undefined
          }
        />
      )}

      {esperandoEnergia && (
        <div className="mt-6 w-full rounded-2xl border border-arena bg-panal p-6">
          <p className="text-[15px] font-medium">La silla está sin luz</p>
          <p className="mt-2 text-sm text-tinta-suave">
            Tu pago entró bien y la silla te está reservada. La encendemos sola
            apenas vuelva la energía — no hace falta que hagas nada.
          </p>
          <p className="mt-3 text-xs text-arena">
            Si no vuelve en unos minutos te dejamos un vale para usar cuando quieras
          </p>
        </div>
      )}

      {sesion?.credito && (
        <TarjetaCredito
          credito={sesion.credito}
          titulo={
            sesion.motivoCierre === "sin_energia_al_pagar"
              ? "No pudimos encender la silla"
              : "Se cortó la luz"
          }
          detalle={
            sesion.motivoCierre === "sin_energia_al_pagar"
              ? `El local se quedó sin energía y no llegamos a prenderla. Tu pago no se pierde: te queda un vale por ${sesion.credito.duracionMin} minutos.`
              : `El corte duró demasiado como para dejarte la silla encendida. Te queda un vale por los ${sesion.credito.duracionMin} minutos que te faltaban.`
          }
        />
      )}

      {sesion?.estado === "COMPLETADA" && (
        <p className="mt-4 text-sm text-tinta-suave">
          ¡Gracias por venir!
          {sesion.segundosCompensados > 0 &&
            ` Por los cortes te sumamos ${formatearDevuelto(sesion.segundosCompensados)}.`}
        </p>
      )}

      {detenidaPorEncargado && (
        <p className="mt-2 text-sm text-tinta-suave">
          El encargado detuvo la silla antes de que se cumpliera tu tiempo.
          Avisale para que lo resuelvan con vos.
        </p>
      )}

      {cancelada && !detenidaPorEncargado && (
        <p className="mt-2 text-sm text-tinta-suave">
          {sesion?.motivoCierre === "pago_no_recibido"
            ? "No llegamos a recibir tu pago y la silla quedó libre. Si pagaste, avisale al encargado y no vuelvas a pagar."
            : sesion?.motivoCierre === "no_confirmo_a_tiempo"
              ? "No llegaste a confirmar a tiempo y la silla quedó libre. Si ya pagaste, avisale al encargado."
              : "La sesión se cerró antes de tiempo. Avisale al encargado."}
        </p>
      )}

      {!sesion && !activaSinSesion && (
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
