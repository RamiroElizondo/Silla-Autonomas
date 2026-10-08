"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, canjearCredito } from "@/lib/api";

/** Caracteres del cuerpo del código (lo que va después de "LUZ-"). */
const LARGO_CUERPO = 8;

/**
 * Deja solo el cuerpo del código: mayúsculas, sin espacios ni guiones, y sin
 * el "LUZ" si el cliente lo escribió o pegó el código entero. Es seguro
 * sacarlo: el alfabeto de los códigos no tiene la L, así que ningún cuerpo
 * empieza con "LUZ".
 */
function limpiarCuerpo(entrada: string): string {
  let limpio = entrada.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (limpio.startsWith("LUZ")) limpio = limpio.slice(3);
  return limpio.slice(0, LARGO_CUERPO);
}

/** "A2B49CDE" → "A2B4-9CDE": el guion se pone solo. */
function formatearCuerpo(cuerpo: string): string {
  return cuerpo.length > 4 ? `${cuerpo.slice(0, 4)}-${cuerpo.slice(4)}` : cuerpo;
}

/**
 * Entrada manual del código de un vale. Es la red de seguridad del cliente
 * que cerró la pestaña o volvió otro día: el botón "Reclamar" de la pantalla
 * de su sesión hace lo mismo, pero esa pantalla se pierde con el navegador.
 */
export function FormCodigoCredito() {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  // Solo el cuerpo, sin "LUZ-" ni guiones: el prefijo está fijo en pantalla.
  const [cuerpo, setCuerpo] = useState("");
  const [canjeando, setCanjeando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function canjear(e: React.FormEvent) {
    e.preventDefault();
    // 8 caracteres (formato actual) o 4 (vales viejos "LUZ-4821").
    if (cuerpo.length !== LARGO_CUERPO && cuerpo.length !== 4) return;
    setCanjeando(true);
    setError(null);
    try {
      const { turnoId } = await canjearCredito(`LUZ-${formatearCuerpo(cuerpo)}`);
      sessionStorage.setItem("turnoPendiente", turnoId);
      router.push(`/cola/${turnoId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Demasiados intentos. Probá de nuevo más tarde.");
      } else {
        setError(err instanceof Error ? err.message : "No se pudo canjear el código");
      }
      setCanjeando(false);
    }
  }

  if (!abierto) {
    return (
      <button
        onClick={() => setAbierto(true)}
        className="mt-8 text-center text-xs text-tinta-muted underline underline-offset-4"
      >
        Tengo un código por un corte de luz
      </button>
    );
  }

  return (
    <form onSubmit={canjear} className="mt-8 rounded-2xl border border-borde bg-marfil p-5">
      <label htmlFor="codigo-credito" className="text-[13px] text-tinta-muted">
        Código del vale
      </label>
      <div className="mt-2 flex w-full items-center justify-center rounded-xl border border-borde bg-white px-4 py-3 text-xl font-medium tabular-nums focus-within:border-terracota">
        <span className="select-none text-tinta-muted" aria-hidden="true">
          LUZ-
        </span>
        <input
          id="codigo-credito"
          value={formatearCuerpo(cuerpo)}
          onChange={(e) => setCuerpo(limpiarCuerpo(e.target.value))}
          placeholder="XXXX-XXXX"
          aria-label="Código del vale, lo que sigue a LUZ-"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="w-[11ch] bg-transparent uppercase outline-none placeholder:text-tinta-muted/50"
        />
      </div>
      <button
        type="submit"
        disabled={canjeando || (cuerpo.length !== LARGO_CUERPO && cuerpo.length !== 4)}
        className="mt-3 w-full rounded-xl bg-terracota py-3.5 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
      >
        {canjeando ? "Canjeando…" : "Canjear"}
      </button>
      {error && <p className="mt-3 text-center text-sm text-terracota-oscuro">{error}</p>}
    </form>
  );
}
