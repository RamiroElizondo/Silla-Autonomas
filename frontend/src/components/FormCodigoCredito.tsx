"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { canjearCredito } from "@/lib/api";

/**
 * Entrada manual del código de un vale. Es la red de seguridad del cliente
 * que cerró la pestaña o volvió otro día: el botón "Reclamar" de la pantalla
 * de su sesión hace lo mismo, pero esa pantalla se pierde con el navegador.
 */
export function FormCodigoCredito() {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [canjeando, setCanjeando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function canjear(e: React.FormEvent) {
    e.preventDefault();
    if (!codigo.trim()) return;
    setCanjeando(true);
    setError(null);
    try {
      const { turnoId } = await canjearCredito(codigo.trim());
      sessionStorage.setItem("turnoPendiente", turnoId);
      router.push(`/cola/${turnoId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo canjear el código");
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
      <input
        id="codigo-credito"
        value={codigo}
        onChange={(e) => setCodigo(e.target.value)}
        placeholder="LUZ-0000"
        autoCapitalize="characters"
        autoComplete="off"
        className="mt-2 w-full rounded-xl border border-borde bg-white px-4 py-3 text-center text-xl font-medium uppercase tabular-nums outline-none focus:border-terracota"
      />
      <button
        type="submit"
        disabled={canjeando}
        className="mt-3 w-full rounded-xl bg-terracota py-3.5 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
      >
        {canjeando ? "Canjeando…" : "Canjear"}
      </button>
      {error && <p className="mt-3 text-center text-sm text-terracota-oscuro">{error}</p>}
    </form>
  );
}
