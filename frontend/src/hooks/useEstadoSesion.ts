"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { obtenerEstadoSesion } from "@/lib/api";
import type { EstadoSesionPublico } from "@/lib/tipos";

/**
 * Estado en vivo de la sesión propia del cliente (mismo patrón que
 * useEstadoSilla). Durante un corte de energía el contador se congela: el
 * backend ya no está descontando ese tiempo, así que la pantalla tampoco.
 */
export function useEstadoSesion(sesionId: string | null, intervaloMs = 4000) {
  const [sesion, setSesion] = useState<EstadoSesionPublico | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segundos, setSegundos] = useState<number | null>(null);

  const sondear = useCallback(async () => {
    if (!sesionId) return;
    try {
      const data = await obtenerEstadoSesion(sesionId);
      setSesion(data);
      setSegundos(data.segundosRestantes);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo conectar");
    }
  }, [sesionId]);

  useEffect(() => {
    if (!sesionId) return;
    sondear();
    const id = setInterval(sondear, intervaloMs);
    return () => clearInterval(id);
  }, [sesionId, sondear, intervaloMs]);

  const segundosRef = useRef(segundos);
  segundosRef.current = segundos;
  const corriendo = sesion?.estado === "ACTIVA" && !sesion.interrumpida;

  useEffect(() => {
    if (!corriendo) return;
    const id = setInterval(() => {
      if (segundosRef.current !== null && segundosRef.current > 0) {
        setSegundos(segundosRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [corriendo]);

  return { sesion, segundos, error, refrescar: sondear };
}

/** "1 minuto y 20 segundos" — para contarle al cliente lo que le devolvimos. */
export function formatearDevuelto(segundos: number): string {
  if (segundos < 60) return `${segundos} segundos`;
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  const minutos = m === 1 ? "1 minuto" : `${m} minutos`;
  return s === 0 ? minutos : `${minutos} y ${s} segundos`;
}
