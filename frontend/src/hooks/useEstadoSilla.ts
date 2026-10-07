"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, obtenerEstado } from "@/lib/api";
import { debeSondearAhora, proximoRetrasoMs } from "@/lib/polling";
import type { EstadoPublico } from "@/lib/tipos";

/**
 * Estado en vivo de una silla: sondea el backend cada `intervaloMs`
 * y entre sondeos descuenta el timer localmente, segundo a segundo.
 *
 * Sondeo (Bloque C): en vez de `setInterval` (intervalo fijo), se
 * reprograma un `setTimeout` después de cada respuesta — necesario para
 * poder esperar más que `intervaloMs` cuando el servidor responde 429 con
 * `Retry-After` (ver `proximoRetrasoMs`), sin dejar un intervalo fijo
 * disparando en paralelo. Mientras la pestaña está oculta se deja de
 * reprogramar el sondeo (no se dispara ningún fetch) y se vuelve a sondear
 * al toque cuando se hace visible de nuevo — más simple que filtrar cada
 * tick, y mejor para una pantalla que alguien tiene justo enfrente: apenas
 * mira el celu de nuevo, ve el dato fresco. `pausarEnOculto=false` (la
 * pantalla TV del local) desactiva esto: ese display sigue sondeando
 * siempre, esté "oculto" o no para el navegador.
 */
export function useEstadoSilla(
  sillaId: string,
  intervaloMs = 5000,
  opciones: { pausarEnOculto?: boolean } = {},
) {
  const { pausarEnOculto = true } = opciones;
  const [estado, setEstado] = useState<EstadoPublico | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segundos, setSegundos] = useState<number | null>(null);
  const [segundosSalida, setSegundosSalida] = useState<number | null>(null);
  const [segundosParaLiberar, setSegundosParaLiberar] = useState<number | null>(null);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activoRef = useRef(true);

  const sondear = useCallback(async () => {
    try {
      const data = await obtenerEstado(sillaId);
      if (!activoRef.current) return;
      setEstado(data);
      setSegundos(data.segundosRestantes);
      setSegundosSalida(data.segundosSalida ?? null);
      setSegundosParaLiberar(data.segundosParaLiberar ?? null);
      setError(null);
      return proximoRetrasoMs({ intervaloBaseMs: intervaloMs, retryAfterMs: null });
    } catch (e) {
      if (!activoRef.current) return;
      setError(e instanceof Error ? e.message : "No se pudo conectar");
      const retryAfterMs = e instanceof ApiError ? (e.retryAfterMs ?? null) : null;
      return proximoRetrasoMs({ intervaloBaseMs: intervaloMs, retryAfterMs });
    }
  }, [sillaId, intervaloMs]);

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

  // Countdown local entre sondeos. En la gracia de inicio (esperando que el
  // cliente presione START) el reloj queda congelado: no se descuenta.
  const segundosRef = useRef(segundos);
  segundosRef.current = segundos;
  const fase = estado?.fase ?? null;
  const masajeCorriendo =
    estado?.estado === "EN_USO" && fase !== "GRACIA" && fase !== "PAUSA" && fase !== "RETORNO";
  useEffect(() => {
    if (!masajeCorriendo) return;
    const id = setInterval(() => {
      if (segundosRef.current !== null && segundosRef.current > 0) {
        setSegundos(segundosRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [masajeCorriendo]);

  const salidaRef = useRef(segundosSalida);
  salidaRef.current = segundosSalida;
  const liberarRef = useRef(segundosParaLiberar);
  liberarRef.current = segundosParaLiberar;
  const enSalida = fase === "PAUSA" || fase === "RETORNO";
  useEffect(() => {
    if (!enSalida) return;
    const id = setInterval(() => {
      if (salidaRef.current !== null && salidaRef.current > 0) {
        setSegundosSalida(salidaRef.current - 1);
      }
      if (liberarRef.current !== null && liberarRef.current > 0) {
        setSegundosParaLiberar(liberarRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [enSalida, fase]);

  return {
    estado,
    segundos,
    segundosSalida,
    segundosParaLiberar,
    fase,
    error,
    refrescar: sondear,
  };
}

export function formatearTimer(segundos: number | null): string {
  if (segundos === null || segundos < 0) return "--:--";
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
