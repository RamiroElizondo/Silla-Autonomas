"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { AvisoCorte } from "@/components/AvisoCorte";
import { BarraProgreso } from "@/components/BarraProgreso";
import { TarjetaCredito } from "@/components/TarjetaCredito";
import { formatearTimer, useEstadoSilla } from "@/hooks/useEstadoSilla";
import { formatearDevuelto, useEstadoSesion } from "@/hooks/useEstadoSesion";
import { confirmarPagoRetorno } from "@/lib/api";

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
    setSesionId(sessionStorage.getItem(`sesionPendiente:${id}`));
  }, [id]);

  const { sesion, segundos } = useEstadoSesion(sesionId, 3000);
  // Respaldo para cuando no tenemos el id (ej. el cliente abrió el link de
  // vuelta en otro navegador): al menos mostramos el estado de la silla.
  const { estado: silla, segundos: segundosSilla } = useEstadoSilla(id, 3000);

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
    if (sesion?.estado === "COMPLETADA") {
      sessionStorage.removeItem(`sesionPendiente:${id}`);
    }
  }, [sesion?.estado, id]);

  const enCurso = sesion?.estado === "ACTIVA" && !sesion.interrumpida;
  const interrumpida = sesion?.estado === "ACTIVA" && sesion.interrumpida;
  const esperandoEnergia = sesion?.estado === "ESPERANDO_ENERGIA";
  const activaSinSesion = !sesion && silla?.estado === "EN_USO";

  const titulo = (() => {
    if (esperandoEnergia) return "Pago confirmado";
    if (interrumpida) return "Tu masaje está en pausa";
    if (sesion?.credito) return "Te debemos un turno";
    if (sesion?.estado === "COMPLETADA") return "Terminó tu masaje";
    if (enCurso || activaSinSesion) return "¡Pago confirmado!";
    if (errorConfirmacion) return "No pudimos confirmar el pago";
    return "Confirmando tu pago…";
  })();

  const timer = sesion ? segundos : segundosSilla;
  const total = (sesion?.duracionMin ?? silla?.duracionMin ?? 0) * 60;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-10 text-center">
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
      <h1 className="mt-5 text-2xl font-medium">{titulo}</h1>

      {(enCurso || activaSinSesion) && (
        <>
          <p className="mt-2 text-sm text-tinta-suave">
            Tu silla ya está encendida. Sentate y disfrutá.
          </p>
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
