"use client";

import { useEffect, useState } from "react";
import { crearSilla, actualizarSilla, listarDispositivos } from "@/lib/api";
import type { DispositivoCloud, SillaAdmin } from "@/lib/tipos";

/**
 * Alta y edición de sillas. En el alta, el dispositivo Shelly se elige
 * de la lista de la cuenta cloud (sin tipear IDs a mano).
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

  const [dispositivos, setDispositivos] = useState<DispositivoCloud[] | null>(
    null,
  );
  const [errorDispositivos, setErrorDispositivos] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    listarDispositivos(token)
      .then(setDispositivos)
      .catch((e) =>
        setErrorDispositivos(
          e instanceof Error ? e.message : "No se pudo consultar Shelly Cloud",
        ),
      );
  }, [token]);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    const payload = {
      nombre: nombre.trim(),
      precio: Number(precio),
      duracionMin: Number(duracionMin),
      deviceIdShelly: deviceId,
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

      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-xs text-tinta-muted">Dispositivo Shelly</span>
        {errorDispositivos ? (
          <p className="rounded-xl bg-terracota-claro px-3.5 py-2.5 text-sm text-terracota-oscuro">
            {errorDispositivos}
          </p>
        ) : dispositivos === null ? (
          <p className="animate-pulse px-1 py-2 text-sm text-tinta-muted">
            Consultando Shelly Cloud…
          </p>
        ) : dispositivos.length === 0 ? (
          <p className="rounded-xl bg-panal px-3.5 py-2.5 text-sm text-tinta-suave">
            No hay dispositivos en la cuenta de Shelly Cloud.
          </p>
        ) : (
          <select
            required
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className={claseInput}
          >
            <option value="" disabled>
              Elegir dispositivo…
            </option>
            {dispositivos.map((d) => (
              <option key={d.deviceId} value={d.deviceId} disabled={!d.online}>
                {d.deviceId}
                {d.modelo ? ` — ${d.modelo}` : ""}
                {d.generacion ? ` (${d.generacion})` : ""}
                {d.online ? "" : " — offline"}
              </option>
            ))}
          </select>
        )}
        <span className="text-xs text-arena">
          Los equipos offline no se pueden vincular: revisá el WiFi del local.
        </span>
      </label>

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
