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
  token,
  silla,
  onListo,
  onCancelar,
}: {
  token: string;
  /** Si viene, es edición; si no, alta. */
  silla?: SillaAdmin;
  onListo: () => void;
  onCancelar: () => void;
}) {
  const [nombre, setNombre] = useState(silla?.nombre ?? "");
  const [precio, setPrecio] = useState(silla ? String(silla.precio) : "");
  const [duracionMin, setDuracionMin] = useState(
    silla ? String(silla.duracionMin) : "10",
  );
  const [deviceId, setDeviceId] = useState(silla?.deviceIdShelly ?? "");

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
      setVerificacion(await verificarDispositivo(token, id));
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
      precio: Number(precio),
      duracionMin: Number(duracionMin),
      deviceIdShelly: deviceId.trim(),
    };
    try {
      if (silla) {
        await actualizarSilla(token, silla.id, payload);
      } else {
        await crearSilla(token, payload);
      }
      onListo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
      setGuardando(false);
    }
  }

  const claseInput =
    "rounded-xl border border-borde bg-crema px-3.5 py-2.5 text-sm outline-none placeholder:text-arena focus:border-borde-fuerte";

  const dev = verificacion?.dispositivo;

  return (
    <form
      onSubmit={guardar}
      className="rounded-xl border border-borde bg-marfil p-5"
    >
      <p className="text-[15px] font-medium">
        {silla ? `Editar ${silla.nombre}` : "Nueva silla"}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-tinta-muted">Nombre</span>
          <input
            required
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Silla 2"
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
            value={precio}
            onChange={(e) => setPrecio(e.target.value)}
            placeholder="3000"
            className={claseInput}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-tinta-muted">Duración (min)</span>
          <input
            required
            type="number"
            min={1}
            max={120}
            value={duracionMin}
            onChange={(e) => setDuracionMin(e.target.value)}
            className={claseInput}
          />
        </label>
      </div>

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
            className={`${claseInput} flex-1 font-mono`}
          />
          <button
            type="button"
            onClick={verificar}
            disabled={verificando || !deviceId.trim()}
            className="rounded-[10px] border border-borde-fuerte px-4 py-2 text-[13px] text-tinta-suave transition hover:bg-panal disabled:opacity-60"
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
            <p className="rounded-xl bg-salvia-claro px-3.5 py-2.5 text-sm text-salvia-oscuro">
              Dispositivo encontrado y online
              {dev?.modelo ? ` — ${dev.modelo}` : ""}
              {dev?.generacion ? ` (${dev.generacion})` : ""}
              {dev?.midePotencia ? " · mide consumo" : " · sin medición de consumo"}
            </p>
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

      <div className="mt-4 flex gap-2.5">
        <button
          type="submit"
          disabled={guardando}
          className="rounded-[10px] bg-terracota px-4 py-2 text-[13px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
        >
          {guardando ? "Guardando…" : silla ? "Guardar cambios" : "Crear silla"}
        </button>
        <button
          type="button"
          onClick={onCancelar}
          className="rounded-[10px] border border-borde-fuerte px-4 py-2 text-[13px] text-tinta-suave transition hover:bg-panal"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
