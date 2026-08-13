"use client";

import { use, useEffect, useState } from "react";
import QRCode from "react-qr-code";
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
  const { estado, segundos } = useEstadoSilla(id, 3000);
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
        <p className="mt-8 text-lg text-arena">Disfrutá tu masaje</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh bg-crema">
      <section className="flex flex-1 flex-col justify-center px-[6vw]">
        <p className="text-sm uppercase tracking-[0.14em] text-tinta-muted">
          Relax Point
        </p>
        <h1 className="mt-3 text-[4.5vw] font-medium leading-tight lg:text-5xl">
          Tu masaje te espera
        </h1>
        <p className="mt-5 text-[6vw] font-medium leading-none text-terracota lg:text-7xl">
          ${estado.precio.toLocaleString("es-AR")}
        </p>
        <p className="mt-3 text-xl text-tinta-suave">
          {estado.duracionMin} minutos · {estado.nombre}
        </p>
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
              ? "Reservada, en un momento se libera o se ocupa…"
              : "Silla en mantenimiento"}
          </p>
        )}
      </section>
    </main>
  );
}
