"use client";

import { use, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { BotonControl } from "@/components/BotonControl";
import { EstadoBadge } from "@/components/EstadoBadge";
import { formatearTimer, useEstadoSilla } from "@/hooks/useEstadoSilla";

/**
 * Vista fullscreen para la TV del local.
 * Libre → precio + QR grande. En uso → timer gigante sobre fondo oscuro.
 */
export default function PantallaTV({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  // La pantalla TV es un display de pared: nunca hay que pausar el
  // sondeo cuando el navegador la considera "oculta" (aunque en un
  // kiosco fullscreen sin cambio de pestaña eso rara vez dispara).
  const { estado, segundos, segundosSalida } = useEstadoSilla(id, 3000, {
    pausarEnOculto: false,
  });
  const [urlLanding, setUrlLanding] = useState("");

  useEffect(() => {
    setUrlLanding(`${window.location.origin}/silla/${id}`);
  }, [id]);

  if (!estado) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-crema">
        <p className="animate-pulse text-lg text-tinta-muted">Conectando…</p>
      </main>
    );
  }

  if (estado.estado === "EN_USO" && (estado.fase === "PAUSA" || estado.fase === "RETORNO")) {
    const retorno = estado.fase === "RETORNO";
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-tinta px-[6vw] text-center">
        <p className="text-base uppercase tracking-[0.14em] text-arena">
          {estado.nombre} · Terminó el masaje
        </p>
        <p className="mt-6 text-[7vw] font-medium leading-tight text-crema lg:text-7xl">
          {retorno ? "Apretá START dos veces" : "Quedate sentado un momento"}
        </p>
        {retorno && (
          <div className="relative mt-8">
            <BotonControl tipo="start" tamano={180} />
            <span className="absolute -right-4 -top-4 rounded-full bg-terracota-tv px-4 py-1 text-3xl font-medium text-crema">
              ×2
            </span>
          </div>
        )}
        <p className="mt-6 text-2xl text-arena">
          {retorno
            ? "El sillón vuelve a la posición normal para que puedas bajarte"
            : "El sillón se va a encender para volver a levantarse"}
        </p>
        <p className="mt-10 text-[6vw] font-medium leading-none text-terracota-tv tabular-nums lg:text-8xl">
          {segundosSalida ?? 0}s
        </p>
      </main>
    );
  }

  if (estado.estado === "EN_USO") {
    const total = estado.duracionMin * 60;
    const pct =
      segundos === null ? 0 : Math.max(0, Math.min(100, (segundos / total) * 100));
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-tinta">
        <p className="text-base uppercase tracking-[0.14em] text-arena">
          {estado.nombre} · En uso
        </p>
        <p className="mt-4 text-[16vw] font-medium leading-none text-crema tabular-nums lg:text-[11rem]">
          {formatearTimer(segundos)}
        </p>
        <div className="mt-10 h-2 w-[46vw] max-w-md overflow-hidden rounded-full bg-tv-pista">
          <div
            className="h-full rounded-full bg-terracota-tv transition-[width] duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
        {estado.fase === "GRACIA" ? (
          <div className="mt-10 flex items-center gap-10 text-left">
            <div className="flex items-center gap-4">
              <BotonControl tipo="start" tamano={110} />
              <p className="max-w-[14rem] text-xl text-crema">1. Apretá START</p>
            </div>
            <div className="flex items-center gap-4">
              <BotonControl tipo="ok" tamano={100} />
              <p className="max-w-[16rem] text-xl text-crema">
                2. Cuando aparezca la pantalla en el control, apretá OK
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-8 text-lg text-arena">Disfrutá tu masaje</p>
        )}
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh bg-crema">
      <section className="flex flex-1 flex-col justify-center px-[6vw]">
        <p className="text-sm uppercase tracking-[0.14em] text-tinta-muted">
          Relajá
        </p>
        <h1 className="mt-3 text-[4.5vw] font-medium leading-tight lg:text-5xl">
          Tu masaje te espera
        </h1>
        <div className="mt-6 flex flex-col gap-4">
          {estado.opciones.map((o) => (
            <p key={o.opcion} className="flex items-baseline gap-5">
              <span className="w-[13vw] text-[3vw] text-tinta-suave tabular-nums lg:w-48 lg:text-4xl">
                {o.duracionMin} min
              </span>
              <span className="text-[5vw] font-medium leading-none text-terracota tabular-nums lg:text-6xl">
                ${o.precio.toLocaleString("es-AR")}
              </span>
            </p>
          ))}
        </div>
        <p className="mt-5 text-xl text-tinta-suave">{estado.nombre}</p>
        <div className="mt-6">
          <EstadoBadge estado={estado.estado} />
        </div>
      </section>

      <section className="flex flex-1 flex-col items-center justify-center gap-6 border-l border-borde bg-marfil">
        {estado.estado === "LIBRE" ? (
          <>
            <div className="rounded-2xl border border-borde bg-white p-6">
              {urlLanding && (
                <QRCode
                  value={urlLanding}
                  size={280}
                  fgColor="#2E2B26"
                  bgColor="#FFFFFF"
                />
              )}
            </div>
            <p className="text-xl font-medium">Escaneá y pagá desde tu celu</p>
          </>
        ) : (
          <p className="max-w-xs text-center text-lg text-tinta-muted">
            {estado.estado === "PAGO_PENDIENTE" || estado.estado === "RESERVADA"
              ? "Reservado, en un momento se libera o se ocupa…"
              : "Sillón en mantenimiento"}
          </p>
        )}
      </section>
    </main>
  );
}
