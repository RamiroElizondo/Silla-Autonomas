"use client";

import { useEffect, useState } from "react";
import { ApiError, obtenerEstadoSillas } from "@/lib/api";
import { proximoRetrasoMs } from "@/lib/polling";
import type { EstadoPublico } from "@/lib/tipos";

/**
 * Estado de todos los sillones para la pantalla TV del local. Mismo esquema
 * de sondeo que useEstadoSilla (setTimeout reprogramado, respeta
 * Retry-After), pero sin pausar nunca: es un display de pared.
 *
 * Los relojes no se descuentan acá: se devuelve `recibidoEn` (hora local de
 * la última respuesta) y la pantalla resta lo transcurrido con
 * `relojLocal`, así un solo tick por segundo mueve todos los sillones.
 */
export function useEstadoSillas(intervaloMs = 3000) {
  const [sillas, setSillas] = useState<EstadoPublico[] | null>(null);
  const [recibidoEn, setRecibidoEn] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let activo = true;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    async function ciclo() {
      let retryAfterMs: number | null = null;
      try {
        const data = await obtenerEstadoSillas();
        if (!activo) return;
        setSillas(data);
        setRecibidoEn(Date.now());
        setError(null);
      } catch (e) {
        if (!activo) return;
        setError(e instanceof Error ? e.message : "No se pudo conectar");
        retryAfterMs = e instanceof ApiError ? (e.retryAfterMs ?? null) : null;
      }
      timeout = setTimeout(ciclo, proximoRetrasoMs({ intervaloBaseMs: intervaloMs, retryAfterMs }));
    }

    ciclo();
    return () => {
      activo = false;
      if (timeout) clearTimeout(timeout);
    };
  }, [intervaloMs]);

  return { sillas, recibidoEn, error };
}

/** Relojes de un sillón descontando lo que pasó desde la última respuesta. */
export function relojLocal(estado: EstadoPublico, transcurridoSeg: number) {
  const restar = (v: number | null | undefined) =>
    v == null ? null : Math.max(0, v - transcurridoSeg);
  const fase = estado.fase ?? null;
  return {
    // En la gracia de inicio el reloj está congelado (esperando START).
    segundos: fase === "GRACIA" ? (estado.segundosRestantes ?? null) : restar(estado.segundosRestantes),
    segundosSalida: restar(estado.segundosSalida),
    segundosParaLiberar: restar(estado.segundosParaLiberar),
  };
}
