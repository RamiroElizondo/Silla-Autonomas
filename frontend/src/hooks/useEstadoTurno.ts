"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, obtenerEstadoTurno } from "@/lib/api";
import { debeSondearAhora, proximoRetrasoMs } from "@/lib/polling";
import type { EstadoTurnoPublico } from "@/lib/tipos";

/**
 * Estado en vivo de un turno en la cola: sondea el backend cada
 * `intervaloMs` (mismo patrón que useEstadoSilla, incluido el `setTimeout`
 * autoreprogramado — ver el comentario ahí) y entre sondeos descuenta
 * localmente la ventana de confirmación o el timer de la sesión.
 */
export function useEstadoTurno(
  turnoId: string,
  intervaloMs = 3000,
  opciones: { pausarEnOculto?: boolean } = {},
) {
  const { pausarEnOculto = true } = opciones;
  const [turno, setTurno] = useState<EstadoTurnoPublico | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segundosVentana, setSegundosVentana] = useState<number | null>(null);
  const [segundosSesion, setSegundosSesion] = useState<number | null>(null);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activoRef = useRef(true);

  const sondear = useCallback(async () => {
    try {
      const data = await obtenerEstadoTurno(turnoId);
      if (!activoRef.current) return;
      setTurno(data);
      setSegundosVentana(data.segundosVentana);
      setSegundosSesion(data.segundosRestantesSesion);
      setError(null);
      return proximoRetrasoMs({ intervaloBaseMs: intervaloMs, retryAfterMs: null });
    } catch (e) {
      if (!activoRef.current) return;
      setError(e instanceof Error ? e.message : "No se pudo conectar");
      const retryAfterMs = e instanceof ApiError ? (e.retryAfterMs ?? null) : null;
      return proximoRetrasoMs({ intervaloBaseMs: intervaloMs, retryAfterMs });
    }
  }, [turnoId, intervaloMs]);

  useEffect(() => {
    activoRef.current = true;

    function limpiarTimeout() {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }

    async function ciclo() {
      if (!activoRef.current) return;
      const oculto = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (!debeSondearAhora({ oculto, pausarEnOculto })) return; // se retoma en visibilitychange
      const espera = await sondear();
      if (!activoRef.current) return;
      timeoutRef.current = setTimeout(ciclo, espera ?? intervaloMs);
    }

    function alCambiarVisibilidad() {
      if (document.visibilityState !== "visible") return;
      limpiarTimeout();
      ciclo();
    }

    ciclo();
    if (typeof document !== "undefined" && pausarEnOculto) {
      document.addEventListener("visibilitychange", alCambiarVisibilidad);
    }

    return () => {
      activoRef.current = false;
      limpiarTimeout();
      if (typeof document !== "undefined" && pausarEnOculto) {
        document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      }
    };
  }, [sondear, intervaloMs, pausarEnOculto]);

  // Countdown local entre sondeos
  const ventanaRef = useRef(segundosVentana);
  ventanaRef.current = segundosVentana;
  const sesionRef = useRef(segundosSesion);
  sesionRef.current = segundosSesion;

  useEffect(() => {
    if (turno?.estado !== "ASIGNADO" && turno?.estado !== "EN_USO") return;
    const id = setInterval(() => {
      if (turno?.estado === "ASIGNADO" && ventanaRef.current !== null && ventanaRef.current > 0) {
        setSegundosVentana(ventanaRef.current - 1);
      }
      if (turno?.estado === "EN_USO" && sesionRef.current !== null && sesionRef.current > 0) {
        setSegundosSesion(sesionRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [turno?.estado]);

  return { turno, segundosVentana, segundosSesion, error, refrescar: sondear };
}
