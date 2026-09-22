"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
let scriptCargando: Promise<void> | null = null;

function cargarScript(): Promise<void> {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve();
  if (scriptCargando) return scriptCargando;
  scriptCargando = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("No se pudo cargar Turnstile"));
    document.head.appendChild(script);
  });
  return scriptCargando;
}

/**
 * Widget de Cloudflare Turnstile para el botón de pagar (Hallazgo ALTO 2 de
 * la auditoría): el backend rechaza el checkout sin un token válido cuando
 * TURNSTILE_SECRET_KEY está configurada. Si acá no está configurada
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY, el widget no se muestra — pensado para
 * desarrollo local, donde el backend también lo tiene deshabilitado.
 */
export function TurnstileWidget({
  onToken,
}: {
  onToken: (token: string | null) => void;
}) {
  const contenedorRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey || !contenedorRef.current) return;
    let cancelado = false;

    cargarScript()
      .then(() => {
        if (cancelado || !contenedorRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(contenedorRef.current, {
          sitekey: siteKey,
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => {
            onToken(null);
            setError("No se pudo verificar. Recargá la página.");
          },
        });
      })
      .catch(() => setError("No se pudo cargar la verificación. Recargá la página."));

    return () => {
      cancelado = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
    };
    // Solo se re-renderiza si cambia la site key (nunca en la práctica).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey) return null;

  return (
    <div className="mt-4 flex flex-col items-center">
      <div ref={contenedorRef} />
      {error && <p className="mt-2 text-xs text-terracota-oscuro">{error}</p>}
    </div>
  );
}
