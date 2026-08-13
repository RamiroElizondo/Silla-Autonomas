"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { obtenerEstadoTurno } from "@/lib/api";
import type { EstadoTurnoPublico } from "@/lib/tipos";

/**
 * Estado en vivo de un turno en la cola: sondea el backend cada
 * `intervaloMs` (mismo patrón que useEstadoSilla) y entre sondeos descuenta
 * localmente la ventana de confirmación o el timer de la sesión.
 */
export function useEstadoTurno(turnoId: string, intervaloMs = 3000) {
  const [turno, setTurno] = useState<EstadoTurnoPublico | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segundosVentana, setSegundosVentana] = useState<number | null>(null);
  const [segundosSesion, setSegundosSesion] = useState<number | null>(null);

  const sondear = useCallback(async () => {
    try {
      const data = await obtenerEstadoTurno(turnoId);
      setTurno(data);
      setSegundosVentana(data.segundosVentana);
      setSegundosSesion(data.segundosRestantesSesion);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo conectar");
    }
  }, [turnoId]);

  useEffect(() => {
    sondear();
    const id = setInterval(sondear, intervaloMs);
    return () => clearInterval(id);
  }, [sondear, intervaloMs]);

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
