"use client";

import { useState } from "react";
import { crearSilla, actualizarSilla, verificarDispositivo } from "@/lib/api";
import type { SillaAdmin, VerificacionDispositivo } from "@/lib/tipos";

/**
 * Alta y edición de sillas. El device Shelly se ingresa a mano y se valida
 * contra la nube con el botón "Verificar": la Cloud Control API v2 no permite
 * listar los dispositivos de la cuenta, así que ya no hay desplegable.
 * El ID está en la app Shelly (Device info) y en la etiqueta del equipo.
 */
export function FormSilla({
  silla,
  onListo,
  onCancelar,
}: {
  /** Si viene, es edición; si no, alta. */
  silla?: SillaAdmin;
  onListo: () => void;
  onCancelar: () => void;
}) {
  const [nombre, setNombre] = useState(silla?.nombre ?? "");
  // Dos opciones de masaje; el cliente elige antes de pagar y viene marcada la 2.
  const [opcion1DuracionMin, setOpcion1DuracionMin] = useState(
    String(silla?.opcion1DuracionMin ?? 5),
  );
  const [opcion1Precio, setOpcion1Precio] = useState(
    silla ? String(silla.opcion1Precio) : "",
  );
  const [opcion2DuracionMin, setOpcion2DuracionMin] = useState(
    String(silla?.opcion2DuracionMin ?? 10),
  );
  const [opcion2Precio, setOpcion2Precio] = useState(
    silla ? String(silla.opcion2Precio) : "",
  );
  const [deviceId, setDeviceId] = useState(silla?.deviceIdShelly ?? "");
  // Tiempos propios de la masajeadora (ver backend/src/sesiones/reloj.util.ts).
  const [graciaInicioSeg, setGraciaInicioSeg] = useState(
    String(silla?.graciaInicioSeg ?? 30),
  );
  const [pausaRetornoSeg, setPausaRetornoSeg] = useState(
    String(silla?.pausaRetornoSeg ?? 10),
  );
  const [retornoSeg, setRetornoSeg] = useState(String(silla?.retornoSeg ?? 40));

  const [verificacion, setVerificacion] = useState<VerificacionDispositivo | null>(
    null,
  );
  const [verificando, setVerificando] = useState(false);
  const [errorVerificacion, setErrorVerificacion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function verificar() {
    const id = deviceId.trim();
    if (!id) return;
    setVerificando(true);
    setVerificacion(null);
    setErrorVerificacion(null);
    try {
      setVerificacion(await verificarDispositivo(id));
    } catch (e) {
      setErrorVerificacion(
        e instanceof Error ? e.message : "No se pudo consultar Shelly Cloud",
      );
    } finally {
      setVerificando(false);
    }
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    const payload = {
      nombre: nombre.trim(),
      opcion1DuracionMin: Number(opcion1DuracionMin),
      opcion1Precio: Number(opcion1Precio),
      opcion2DuracionMin: Number(opcion2DuracionMin),
      opcion2Precio: Number(opcion2Precio),
      deviceIdShelly: deviceId.trim(),
      graciaInicioSeg: Number(graciaInicioSeg),
      pausaRetornoSeg: Number(pausaRetornoSeg),
      retornoSeg: Number(retornoSeg),
    };
    try {
      if (silla) {
        await actualizarSilla(silla.id, payload);
      } else {
        await crearSilla(payload);
      }
      onListo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
      setGuardando(false);
    }
  }

  const claseInput =
    "rounded-xl border border-borde bg-crema px-3.5 py-2.5 text-base outline-none sm:text-sm placeholder:text-arena focus:border-borde-fuerte";

  const dev = verificacion?.dispositivo;

  return (
    <form
      onSubmit={guardar}
      className="rounded-xl border border-borde bg-marfil p-4 sm:p-5"
    >
      <p className="text-[15px] font-medium">
        {silla ? `Editar ${silla.nombre}` : "Nuevo sillón"}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-tinta-muted">Nombre</span>
          <input
            required
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Sillón 2"
            className={claseInput}
          />
        </label>
      </div>

      {(
        [
          {
            n: 1,
            titulo: "Opción 1",
            duracion: opcion1DuracionMin,
            setDuracion: setOpcion1DuracionMin,
            precio: opcion1Precio,
            setPrecio: setOpcion1Precio,
            placeholder: "1500",
          },
          {
            n: 2,
            titulo: "Opción 2 · viene seleccionada",
            duracion: opcion2DuracionMin,
            setDuracion: setOpcion2DuracionMin,
            precio: opcion2Precio,
            setPrecio: setOpcion2Precio,
            placeholder: "3000",
          },
        ] as const
      ).map((o) => (
        <fieldset key={o.n} className="mt-4">
          <legend className="text-xs font-medium text-tinta-suave">{o.titulo}</legend>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-tinta-muted">Duración (min)</span>
              <input
                required
                type="number"
                min={1}
                max={120}
                value={o.duracion}
                onChange={(e) => o.setDuracion(e.target.value)}
                className={claseInput}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-tinta-muted">Precio (AR$)</span>
              <input
                required
                type="number"
                min={1}
                step="any"
                value={o.precio}
                onChange={(e) => o.setPrecio(e.target.value)}
                placeholder={o.placeholder}
                className={claseInput}
              />
            </label>
          </div>
        </fieldset>
      ))}

      <fieldset className="mt-4">
        <legend className="text-xs font-medium text-tinta-suave">
          Tiempos del sillón (segundos)
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-tinta-muted">Gracia al inicio</span>
            <input
              required
              type="number"
              min={0}
              max={120}
              value={graciaInicioSeg}
              onChange={(e) => setGraciaInicioSeg(e.target.value)}
              className={claseInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-tinta-muted">Pausa al terminar</span>
            <input
              required
              type="number"
              min={0}
              max={60}
              value={pausaRetornoSeg}
              onChange={(e) => setPausaRetornoSeg(e.target.value)}
              className={claseInput}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-tinta-muted">Retorno (levantar sillón)</span>
            <input
              required
              type="number"
              min={0}
              max={120}
              value={retornoSeg}
              onChange={(e) => setRetornoSeg(e.target.value)}
              className={claseInput}
            />
          </label>
        </div>
        <span className="mt-1.5 block text-xs text-arena">
          Gracia: tiempo extra (que el cliente no ve) para sentarse y presionar
          START. Al terminar, el sillón se apaga durante la pausa y después
          recibe corriente durante el retorno para que, con START, vuelva a
          levantarse. Si el retorno es muy largo arranca otra pasada y el sillón
          se vuelve a acostar. Retorno en 0 desactiva esta fase.
        </span>
      </fieldset>

      <div className="mt-3 flex flex-col gap-1.5">
        <label
          htmlFor="deviceIdShelly"
          className="text-xs text-tinta-muted"
        >
          Dispositivo Shelly
        </label>
        <div className="flex gap-2">
          <input
            id="deviceIdShelly"
            required
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              setVerificacion(null);
              setErrorVerificacion(null);
            }}
            placeholder="e4b063f1a2c3"
            spellCheck={false}
            autoComplete="off"
            className={`${claseInput} min-w-0 flex-1 font-mono`}
          />
          <button
            type="button"
            onClick={verificar}
            disabled={verificando || !deviceId.trim()}
            className="inline-flex min-h-11 items-center whitespace-nowrap rounded-[10px] border border-borde-fuerte px-4 py-2 text-[13px] text-tinta-suave transition hover:bg-panal disabled:opacity-60 sm:min-h-0"
          >
            {verificando ? "Verificando…" : "Verificar"}
          </button>
        </div>

        {errorVerificacion && (
          <p className="rounded-xl bg-terracota-claro px-3.5 py-2.5 text-sm text-terracota-oscuro">
            {errorVerificacion}
          </p>
        )}

        {verificacion &&
          (verificacion.vinculable ? (
            <>
              <p className="rounded-xl bg-salvia-claro px-3.5 py-2.5 text-sm text-salvia-oscuro">
                Dispositivo encontrado y online
                {dev?.modelo ? ` — ${dev.modelo}` : ""}
                {dev?.generacion ? ` (${dev.generacion})` : ""}
                {dev?.midePotencia ? " · mide consumo" : " · sin medición de consumo"}
              </p>
              {verificacion.advertencia && (
                <p className="rounded-xl bg-panal px-3.5 py-2.5 text-sm text-tinta-suave">
                  ⚠ {verificacion.advertencia}
                </p>
              )}
            </>
          ) : (
            <p className="rounded-xl bg-terracota-claro px-3.5 py-2.5 text-sm text-terracota-oscuro">
              {verificacion.motivo}
            </p>
          ))}

        <span className="text-xs text-arena">
          El ID figura en la app Shelly (Device info) y en la etiqueta del
          equipo. No se puede vincular un equipo offline: revisá el WiFi del
          local.
        </span>
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-terracota-claro px-3.5 py-2.5 text-sm text-terracota-oscuro">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
        <button
          type="submit"
          disabled={guardando}
          className="min-h-11 rounded-[10px] bg-terracota px-4 py-2 text-[13px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60 sm:min-h-0"
        >
          {guardando ? "Guardando…" : silla ? "Guardar cambios" : "Crear sillón"}
        </button>
        <button
          type="button"
          onClick={onCancelar}
          className="min-h-11 rounded-[10px] border border-borde-fuerte px-4 py-2 text-[13px] text-tinta-suave transition hover:bg-panal sm:min-h-0"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
