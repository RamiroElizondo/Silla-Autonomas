"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import logo from "@/assets/relaja-logo.png";
import { BotonControl } from "@/components/BotonControl";
import { EstadoBadge } from "@/components/EstadoBadge";
import { relojLocal, useEstadoSillas } from "@/hooks/useEstadoSillas";
import { formatearTimer } from "@/hooks/useEstadoSilla";
import type { EstadoPublico, OpcionMasaje } from "@/lib/tipos";

/**
 * Pantalla TV única del local (`/pantalla`). Cada sillón ocupa su mitad:
 * nombre, estado, su QR (siempre visible) y, si hay turno, la cuenta
 * regresiva. Entre los dos QR va el "Escaneá, pagá y relajá"; si los
 * sillones tienen las mismas opciones se muestran una sola vez abajo al
 * centro, y si no, cada uno muestra las suyas debajo de su QR.
 *
 * Todo se dimensiona en vh para que entre sin scroll en cualquier TV.
 */
export default function PantallaTV() {
  const { sillas, recibidoEn } = useEstadoSillas(3000);
  const [ahora, setAhora] = useState(() => Date.now());
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const transcurrido = recibidoEn ? Math.max(0, Math.floor((ahora - recibidoEn) / 1000)) : 0;
  const comunes = opcionesComunes(sillas ?? []);

  const escanea = (
    <p className="text-center text-[5.2vh] font-medium leading-[1.15]">
      Escaneá,
      <br />
      pagá y relajá
    </p>
  );

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-crema px-[4vw] py-[3vh]">
      <header className="flex shrink-0 justify-center">
        <img src={logo.src} alt="Relajá — 10 minutos para vos" className="h-[22vh] w-auto" />
      </header>

      {!sillas ? (
        <p className="m-auto animate-pulse text-[3vh] text-tinta-muted">Conectando…</p>
      ) : sillas.length === 0 ? (
        <p className="m-auto text-[3vh] text-tinta-muted">No hay sillones configurados</p>
      ) : (
        <>
          {sillas.length === 2 ? (
            <section className="mt-[3vh] grid min-h-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-[3vw]">
              <MitadSillon
                estado={sillas[0]}
                transcurrido={transcurrido}
                origin={origin}
                mostrarOpciones={!comunes}
              />
              {escanea}
              <MitadSillon
                estado={sillas[1]}
                transcurrido={transcurrido}
                origin={origin}
                mostrarOpciones={!comunes}
              />
            </section>
          ) : (
            <section className="mt-[3vh] flex min-h-0 flex-1 items-center justify-center gap-[4vw]">
              {sillas.length === 1 && escanea}
              {sillas.map((s) => (
                <MitadSillon
                  key={s.id}
                  estado={s}
                  transcurrido={transcurrido}
                  origin={origin}
                  mostrarOpciones={!comunes}
                />
              ))}
            </section>
          )}

          {comunes && (
            <footer className="mt-[2vh] flex shrink-0 items-baseline justify-center gap-[4vw]">
              {comunes.map((o) => (
                <p key={o.opcion} className="flex items-baseline gap-[1.2vw]">
                  <span className="text-[4.4vh] text-tinta-suave tabular-nums">
                    {o.duracionMin} min
                  </span>
                  <span className="text-[6.4vh] font-medium leading-none text-terracota tabular-nums">
                    ${o.precio.toLocaleString("es-AR")}
                  </span>
                </p>
              ))}
            </footer>
          )}
        </>
      )}
    </main>
  );
}

/** Las opciones si todos los sillones tienen las mismas; si no, null. */
function opcionesComunes(sillas: EstadoPublico[]): OpcionMasaje[] | null {
  if (sillas.length === 0) return null;
  const clave = (o: OpcionMasaje[]) =>
    o.map((x) => `${x.opcion}:${x.duracionMin}:${x.precio}`).join("|");
  const primera = clave(sillas[0].opciones);
  return sillas.every((s) => clave(s.opciones) === primera) ? sillas[0].opciones : null;
}

function MitadSillon({
  estado,
  transcurrido,
  origin,
  mostrarOpciones,
}: {
  estado: EstadoPublico;
  transcurrido: number;
  origin: string;
  mostrarOpciones: boolean;
}) {
  const sinEnergia = estado.sinEnergia && estado.estado !== "FUERA_DE_SERVICIO";
  const noDisponible = estado.estado === "FUERA_DE_SERVICIO" || sinEnergia;
  const url = origin ? `${origin}/silla/${estado.id}` : "";

  return (
    <article className="flex min-w-0 flex-col items-center">
      <div className="flex items-center gap-[1.5vh]">
        <h2 className="text-[3.6vh] font-medium">{estado.nombre}</h2>
        <EstadoBadge estado={estado.estado} sinEnergia={sinEnergia} grande />
      </div>

      <div
        className={`mt-[2vh] rounded-[2.4vh] border border-borde bg-white p-[2vh] transition-opacity ${
          noDisponible ? "opacity-35" : ""
        }`}
      >
        <div className="h-[27vh] w-[27vh]">
          {url && (
            <QRCode
              value={url}
              size={256}
              fgColor="#2E2B26"
              bgColor="#FFFFFF"
              style={{ width: "100%", height: "100%" }}
            />
          )}
        </div>
      </div>

      {/* Alto fijo: que el QR no salte cuando cambia el estado. */}
      <div className="mt-[2.2vh] flex h-[16vh] w-full flex-col items-center justify-center text-center">
        <Detalle estado={estado} transcurrido={transcurrido} sinEnergia={sinEnergia} />
      </div>

      {mostrarOpciones && (
        <p className="mt-[1vh] text-[2.6vh] text-tinta-suave tabular-nums">
          {estado.opciones
            .map((o) => `${o.duracionMin} min $${o.precio.toLocaleString("es-AR")}`)
            .join("  ·  ")}
        </p>
      )}
    </article>
  );
}

function Detalle({
  estado,
  transcurrido,
  sinEnergia,
}: {
  estado: EstadoPublico;
  transcurrido: number;
  sinEnergia: boolean;
}) {
  const texto = "text-[2.8vh] text-tinta-suave";

  if (estado.estado === "FUERA_DE_SERVICIO") {
    return <p className={texto}>En mantenimiento</p>;
  }
  if (sinEnergia) {
    return <p className={texto}>Sin conexión, puede ser un corte de luz</p>;
  }
  if (estado.estado === "LIBRE") {
    return <p className={texto}>Escaneá el código para empezar</p>;
  }
  if (estado.estado === "PAGO_PENDIENTE" || estado.estado === "RESERVADA") {
    return <p className={texto}>Alguien está por usarlo</p>;
  }

  // EN_USO
  const reloj = relojLocal(estado, transcurrido);

  if (estado.fase === "PAUSA") {
    return (
      <>
        <p className="text-[3.2vh] font-medium">Terminó el masaje</p>
        <p className={`mt-[0.8vh] ${texto}`}>
          Quedate sentado · se libera en{" "}
          <span className="tabular-nums">{reloj.segundosParaLiberar ?? 0}s</span>
        </p>
      </>
    );
  }
  if (estado.fase === "RETORNO") {
    return (
      <>
        <div className="flex items-center gap-[1.5vh]">
          <div className="relative">
            <BotonControl tipo="start" tamano={64} />
            <span className="absolute -right-3 -top-3 rounded-full bg-terracota px-2 py-0.5 text-[1.8vh] font-medium text-crema">
              ×2
            </span>
          </div>
          <p className="text-[3vh] font-medium">Apretá START dos veces</p>
        </div>
        <p className={`mt-[1vh] ${texto}`}>
          para levantar el sillón · libre en{" "}
          <span className="tabular-nums">{reloj.segundosParaLiberar ?? 0}s</span>
        </p>
      </>
    );
  }

  const total = estado.duracionMin * 60;
  const pct =
    reloj.segundos === null ? 0 : Math.max(0, Math.min(100, (reloj.segundos / total) * 100));

  return (
    <>
      <p className="text-[10vh] font-medium leading-none tabular-nums">
        {formatearTimer(reloj.segundos)}
      </p>
      {/* En la gracia el reloj está congelado: en lugar de la barra va la
          indicación de cómo arrancar el sillón. */}
      {estado.fase === "GRACIA" ? (
        <p className="mt-[1.4vh] flex items-center gap-[1vh] text-[2.4vh] text-tinta-suave">
          <BotonControl tipo="start" tamano={40} /> Apretá START y después OK
        </p>
      ) : (
        <div className="mt-[1.6vh] h-[0.9vh] w-[27vh] overflow-hidden rounded-full bg-pista">
          <div
            className="h-full rounded-full bg-terracota transition-[width] duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </>
  );
}
