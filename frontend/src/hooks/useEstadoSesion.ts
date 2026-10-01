"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, obtenerEstadoSesion } from "@/lib/api";
import { debeSondearAhora, proximoRetrasoMs } from "@/lib/polling";
import type { EstadoSesionPublico } from "@/lib/tipos";

/**
 * Estado en vivo de la sesión propia del cliente (mismo patrón que
 * useEstadoSilla, incluido el sondeo con `setTimeout` autoreprogramado en
 * vez de `setInterval` — ver el comentario ahí para el porqué). Durante un
 * corte de energía el contador se congela: el backend ya no está
 * descontando ese tiempo, así que la pantalla tampoco.
 */
export function useEstadoSesion(
  sesionId: string | null,
  intervaloMs = 4000,
  opciones: { pausarEnOculto?: boolean } = {},
) {
  const { pausarEnOculto = true } = opciones;
  const [sesion, setSesion] = useState<EstadoSesionPublico | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segundos, setSegundos] = useState<number | null>(null);
  const [segundosVentana, setSegundosVentana] = useState<number | null>(null);
  const [segundosSalida, setSegundosSalida] = useState<number | null>(null);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activoRef = useRef(true);

  const sondear = useCallback(async () => {
    if (!sesionId) return;
    try {
      const data = await obtenerEstadoSesion(sesionId);
      if (!activoRef.current) return;
      setSesion(data);
      setSegundos(data.segundosRestantes);
      setSegundosVentana(data.segundosVentana ?? null);
      setSegundosSalida(data.segundosSalida ?? null);
      setError(null);
      return proximoRetrasoMs({ intervaloBaseMs: intervaloMs, retryAfterMs: null });
    } catch (e) {
      if (!activoRef.current) return;
      setError(e instanceof Error ? e.message : "No se pudo conectar");
      const retryAfterMs = e instanceof ApiError ? (e.retryAfterMs ?? null) : null;
      return proximoRetrasoMs({ intervaloBaseMs: intervaloMs, retryAfterMs });
    }
  }, [sesionId, intervaloMs]);

  useEffect(() => {
    if (!sesionId) return;
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
  }, [sesionId, sondear, intervaloMs, pausarEnOculto]);

  const segundosRef = useRef(segundos);
  segundosRef.current = segundos;
  // En la gracia de inicio (esperando START) el reloj queda congelado.
  const corriendo =
    sesion?.estado === "ACTIVA" && !sesion.interrumpida && sesion.fase !== "GRACIA";

  useEffect(() => {
    if (!corriendo) return;
    const id = setInterval(() => {
      if (segundosRef.current !== null && segundosRef.current > 0) {
        setSegundos(segundosRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [corriendo]);

  const ventanaRef = useRef(segundosVentana);
  ventanaRef.current = segundosVentana;
  const esperandoConfirmacion = sesion?.estado === "ESPERANDO_CONFIRMACION";

  useEffect(() => {
    if (!esperandoConfirmacion) return;
    const id = setInterval(() => {
      if (ventanaRef.current !== null && ventanaRef.current > 0) {
        setSegundosVentana(ventanaRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [esperandoConfirmacion]);

  const salidaRef = useRef(segundosSalida);
  salidaRef.current = segundosSalida;
  const faseSalida = sesion?.estado === "SALIDA" ? (sesion.fase ?? null) : null;

  useEffect(() => {
    if (!faseSalida) return;
    const id = setInterval(() => {
      if (salidaRef.current !== null && salidaRef.current > 0) {
        setSegundosSalida(salidaRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [faseSalida]);

  return { sesion, segundos, segundosVentana, segundosSalida, error, refrescar: sondear };
}

/** "1 minuto y 20 segundos" — para contarle al cliente lo que le devolvimos. */
export function formatearDevuelto(segundos: number): string {
  if (segundos < 60) return `${segundos} segundos`;
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  const minutos = m === 1 ? "1 minuto" : `${m} minutos`;
  return s === 0 ? minutos : `${minutos} y ${s} segundos`;
}
