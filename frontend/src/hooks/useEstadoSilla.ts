"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { obtenerEstado } from "@/lib/api";
import type { EstadoPublico } from "@/lib/tipos";

/**
 * Estado en vivo de una silla: sondea el backend cada `intervaloMs`
 * y entre sondeos descuenta el timer localmente, segundo a segundo.
 */
export function useEstadoSilla(sillaId: string, intervaloMs = 5000) {
  const [estado, setEstado] = useState<EstadoPublico | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segundos, setSegundos] = useState<number | null>(null);

  const sondear = useCallback(async () => {
    try {
      const data = await obtenerEstado(sillaId);
      setEstado(data);
      setSegundos(data.segundosRestantes);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo conectar");
    }
  }, [sillaId]);

  useEffect(() => {
    sondear();
    const id = setInterval(sondear, intervaloMs);
    return () => clearInterval(id);
  }, [sondear, intervaloMs]);

  // Countdown local entre sondeos
  const segundosRef = useRef(segundos);
  segundosRef.current = segundos;
  useEffect(() => {
    if (estado?.estado !== "EN_USO") return;
    const id = setInterval(() => {
      if (segundosRef.current !== null && segundosRef.current > 0) {
        setSegundos(segundosRef.current - 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [estado?.estado]);

  return { estado, segundos, error, refrescar: sondear };
}

export function formatearTimer(segundos: number | null): string {
  if (segundos === null || segundos < 0) return "--:--";
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
