"use client";

import { useCallback, useEffect, useState } from "react";
import { EstadoBadge } from "@/components/EstadoBadge";
import { FormSilla } from "@/components/FormSilla";
import {
  activarManual,
  login,
  obtenerHistorial,
  obtenerSillasAdmin,
  pararEmergencia,
  probarSilla,
} from "@/lib/api";
import type { ResultadoPrueba, SesionAdmin, SillaAdmin } from "@/lib/tipos";

const TOKEN_KEY = "admin_token";

export default function Admin() {
  const [token, setToken] = useState<string | null>(null);
  const [listo, setListo] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
    setListo(true);
  }, []);

  if (!listo) return null;

  return token ? (
    <Dashboard
      token={token}
      onCerrarSesion={() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }}
    />
  ) : (
    <Login
      onLogin={(t) => {
        localStorage.setItem(TOKEN_KEY, t);
        setToken(t);
      }}
    />
  );
}

/* ---------- Login ---------- */

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setCargando(true);
    setError(null);
    try {
      const { token } = await login(email, password);
      onLogin(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión");
      setCargando(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <p className="text-xs uppercase tracking-[0.12em] text-tinta-muted">
        Relax Point
      </p>
      <h1 className="mt-1.5 text-2xl font-medium">Panel del local</h1>
      <form onSubmit={entrar} className="mt-8 flex flex-col gap-3">
        <input
          type="email"
          required
          placeholder="tu@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-xl border border-borde bg-marfil px-4 py-3.5 text-[15px] outline-none placeholder:text-arena focus:border-borde-fuerte"
        />
        <input
          type="password"
          required
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl border border-borde bg-marfil px-4 py-3.5 text-[15px] outline-none placeholder:text-arena focus:border-borde-fuerte"
        />
        <button
          type="submit"
          disabled={cargando}
          className="mt-2 rounded-xl bg-terracota py-3.5 text-[15px] font-medium text-terracota-claro transition hover:bg-terracota-hover disabled:opacity-60"
        >
          {cargando ? "Entrando…" : "Entrar"}
        </button>
        {error && (
          <p className="text-center text-sm text-terracota-oscuro">{error}</p>
        )}
      </form>
    </main>
  );
}

/* ---------- Dashboard ---------- */

function Dashboard({
  token,
  onCerrarSesion,
}: {
  token: string;
  onCerrarSesion: () => void;
}) {
  const [sillas, setSillas] = useState<SillaAdmin[]>([]);
  const [sesiones, setSesiones] = useState<SesionAdmin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [accionando, setAccionando] = useState<string | null>(null);
  /** null = cerrado, "nueva" = alta, SillaAdmin = edición */
  const [form, setForm] = useState<"nueva" | SillaAdmin | null>(null);
  const [pruebas, setPruebas] = useState<
    Record<string, ResultadoPrueba | "cargando" | { error: string }>
  >({});
  const [confirmarParar, setConfirmarParar] = useState<SillaAdmin | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        obtenerSillasAdmin(token),
        obtenerHistorial(token, 50),
      ]);
      setSillas(s);
      setSesiones(h.items);
      setError(null);
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : "Error de conexión";
      if (mensaje.includes("401")) onCerrarSesion();
      setError(mensaje);
    }
  }, [token, onCerrarSesion]);

  useEffect(() => {
    cargar();
    const id = setInterval(cargar, 5000);
    return () => clearInterval(id);
  }, [cargar]);

  async function probar(sillaId: string) {
    setPruebas((p) => ({ ...p, [sillaId]: "cargando" }));
    try {
      const r = await probarSilla(token, sillaId);
      setPruebas((p) => ({ ...p, [sillaId]: r }));
    } catch (e) {
      setPruebas((p) => ({
        ...p,
        [sillaId]: { error: e instanceof Error ? e.message : "Falló la prueba" },
      }));
    }
  }

  async function accion(
    sillaId: string,
    fn: (t: string, id: string) => Promise<unknown>,
  ) {
    setAccionando(sillaId);
    try {
      await fn(token, sillaId);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La acción falló");
    } finally {
      setAccionando(null);
    }
  }

  const hoy = new Date().toDateString();
  const esteMes = new Date().getMonth();
  const cobradas = sesiones.filter(
    (s) => s.estado === "ACTIVA" || s.estado === "COMPLETADA",
  );
  const deHoy = cobradas.filter((s) => new Date(s.creadaEn).toDateString() === hoy);
  const delMes = cobradas.filter(
    (s) => new Date(s.creadaEn).getMonth() === esteMes,
  );
  const suma = (xs: SesionAdmin[]) =>
    xs.reduce((acc, s) => acc + (s.esManual ? 0 : Number(s.monto)), 0);

  const shellyOk = sillas.every((s) => s.salud?.online !== false);

  return (
    <main className="mx-auto max-w-3xl px-6 pb-16">
      <header className="flex items-center justify-between border-b border-borde py-5">
        <div className="flex items-baseline gap-2.5">
          <span className="text-lg font-medium">Relax Point</span>
          <span className="text-xs text-tinta-muted">Panel</span>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-tinta-suave">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${shellyOk ? "bg-salvia" : "bg-terracota"}`}
            />
            {shellyOk ? "Shelly conectado" : "Shelly con problemas"}
          </span>
          <button onClick={onCerrarSesion} className="underline underline-offset-4">
            Salir
          </button>
        </div>
      </header>

      {error && (
        <p className="mt-4 rounded-xl bg-terracota-claro px-4 py-3 text-sm text-terracota-oscuro">
          {error}
        </p>
      )}

      <section className="mt-6 grid grid-cols-3 gap-2.5">
        <Metrica etiqueta="Ingresos hoy" valor={`$${suma(deHoy).toLocaleString("es-AR")}`} />
        <Metrica etiqueta="Sesiones hoy" valor={String(deHoy.length)} />
        <Metrica etiqueta="Este mes" valor={`$${suma(delMes).toLocaleString("es-AR")}`} />
      </section>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-tinta-suave">Sillas</h2>
        {form === null && (
          <button
            onClick={() => setForm("nueva")}
            className="rounded-[10px] border border-borde-fuerte px-3 py-2 text-[13px] text-tinta-suave transition hover:bg-panal"
          >
            + Agregar silla
          </button>
        )}
      </div>
      <section className="mt-2.5 flex flex-col gap-2.5">
        {form !== null && (
          <FormSilla
            token={token}
            silla={form === "nueva" ? undefined : form}
            onListo={() => {
              setForm(null);
              cargar();
            }}
            onCancelar={() => setForm(null)}
          />
        )}
        {sillas.length === 0 && form === null && (
          <p className="rounded-xl border border-borde bg-marfil px-5 py-6 text-sm text-tinta-muted">
            Todavía no hay sillas dadas de alta. Agregá la primera con el botón
            de arriba.
          </p>
        )}
        {sillas.map((silla) => (
          <article
            key={silla.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-borde bg-marfil px-5 py-4"
          >
            <div className="flex items-center gap-3.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-terracota-claro text-terracota">
                <IconoSilla />
              </div>
              <div>
                <p className="text-[15px] font-medium">{silla.nombre}</p>
                <p className="mt-0.5 text-[13px] text-tinta-muted">
                  ${silla.precio.toLocaleString("es-AR")} · {silla.duracionMin} min
                  {silla.modeloShelly && ` · ${silla.modeloShelly}`}
                  {silla.salud?.potenciaW != null &&
                    ` · consumo ${Math.round(silla.salud.potenciaW)} W`}
                </p>
                <ResultadoPruebaLinea resultado={pruebas[silla.id]} />
                {silla.salud?.alertas?.map((a) => (
                  <p key={a} className="mt-0.5 text-[13px] text-terracota-oscuro">
                    ⚠ {a}
                  </p>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <EstadoBadge estado={silla.estado} />
              <button
                onClick={() => probar(silla.id)}
                disabled={pruebas[silla.id] === "cargando"}
                className="rounded-[10px] border border-borde-fuerte px-3 py-2 text-[13px] text-tinta-suave transition hover:bg-panal disabled:opacity-50"
              >
                {pruebas[silla.id] === "cargando" ? "Probando…" : "Probar"}
              </button>
              <button
                onClick={() => setForm(silla)}
                className="rounded-[10px] border border-borde-fuerte px-3 py-2 text-[13px] text-tinta-suave transition hover:bg-panal"
              >
                Editar
              </button>
              {silla.estado === "LIBRE" && (
                <button
                  onClick={() => accion(silla.id, activarManual)}
                  disabled={accionando === silla.id}
                  className="rounded-[10px] border border-borde-fuerte px-3 py-2 text-[13px] text-tinta-suave transition hover:bg-panal disabled:opacity-50"
                >
                  Activar manual
                </button>
              )}
              {silla.estado === "EN_USO" && (
                <button
                  onClick={() => setConfirmarParar(silla)}
                  disabled={accionando === silla.id}
                  className="rounded-[10px] border border-terracota-borde px-3 py-2 text-[13px] text-terracota-oscuro transition hover:bg-terracota-claro disabled:opacity-50"
                >
                  Parar
                </button>
              )}
            </div>
          </article>
        ))}
      </section>

      <h2 className="mt-8 text-[13px] font-medium text-tinta-suave">
        Últimas operaciones
      </h2>
      <section className="mt-2.5 overflow-hidden rounded-xl border border-borde bg-marfil">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-tinta-muted">
              <th className="px-4 py-2.5 font-medium">Fecha</th>
              <th className="px-2 py-2.5 font-medium">Silla</th>
              <th className="px-2 py-2.5 font-medium">Monto</th>
              <th className="px-4 py-2.5 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {sesiones.map((s) => (
              <tr key={s.id} className="border-t border-borde-suave">
                <td className="px-4 py-2.5 text-tinta-suave">
                  {new Date(s.creadaEn).toLocaleString("es-AR", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="px-2 py-2.5">{s.silla?.nombre ?? "—"}</td>
                <td className="px-2 py-2.5">
                  {s.esManual ? "Manual" : `$${Number(s.monto).toLocaleString("es-AR")}`}
                </td>
                <td className="px-4 py-2.5">
                  <BadgeSesion estado={s.estado} />
                </td>
              </tr>
            ))}
            {sesiones.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-tinta-muted">
                  Sin operaciones todavía
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {confirmarParar && (
        <ModalConfirmar
          titulo="Parada de emergencia"
          mensaje={`Se va a cortar la corriente de ${confirmarParar.nombre} y la sesión en curso quedará cancelada.`}
          textoConfirmar="Sí, cortar"
          onConfirmar={() => {
            const silla = confirmarParar;
            setConfirmarParar(null);
            accion(silla.id, pararEmergencia);
          }}
          onCancelar={() => setConfirmarParar(null)}
        />
      )}
    </main>
  );
}

function ModalConfirmar({
  titulo,
  mensaje,
  textoConfirmar,
  onConfirmar,
  onCancelar,
}: {
  titulo: string;
  mensaje: string;
  textoConfirmar: string;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-tinta/25 px-6 backdrop-blur-[2px]"
      onClick={onCancelar}
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-borde bg-marfil p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[17px] font-medium">{titulo}</h3>
        <p className="mt-2 text-sm leading-relaxed text-tinta-suave">{mensaje}</p>
        <div className="mt-6 flex justify-end gap-2.5">
          <button
            onClick={onCancelar}
            className="rounded-[10px] border border-borde-fuerte px-4 py-2.5 text-[13px] text-tinta-suave transition hover:bg-panal"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirmar}
            className="rounded-[10px] bg-terracota px-4 py-2.5 text-[13px] font-medium text-terracota-claro transition hover:bg-terracota-hover"
          >
            {textoConfirmar}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultadoPruebaLinea({
  resultado,
}: {
  resultado?: ResultadoPrueba | "cargando" | { error: string };
}) {
  if (!resultado || resultado === "cargando") return null;
  if ("error" in resultado) {
    return (
      <p className="mt-0.5 text-[13px] text-terracota-oscuro">
        ✕ {resultado.error}
      </p>
    );
  }
  if (!resultado.online) {
    return (
      <p className="mt-0.5 text-[13px] text-terracota-oscuro">
        ✕ Offline — revisar WiFi del local
      </p>
    );
  }
  return (
    <p className="mt-0.5 text-[13px] text-salvia-oscuro">
      ✓ Online · relé{" "}
      {resultado.releEncendido === true
        ? "encendido"
        : resultado.releEncendido === false
          ? "apagado"
          : "sin datos"}
      {resultado.potenciaW != null && ` · ${Math.round(resultado.potenciaW)} W`}
    </p>
  );
}

function Metrica({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="rounded-xl border border-borde bg-marfil px-4 py-3.5">
      <p className="text-xs text-tinta-muted">{etiqueta}</p>
      <p className="mt-1 text-2xl font-medium">{valor}</p>
    </div>
  );
}

function BadgeSesion({ estado }: { estado: SesionAdmin["estado"] }) {
  const estilos: Record<SesionAdmin["estado"], [string, string]> = {
    ACTIVA: ["bg-terracota-claro text-terracota-oscuro", "Activa"],
    COMPLETADA: ["bg-salvia-claro text-salvia-oscuro", "Completada"],
    PENDIENTE: ["bg-panal text-tinta-suave", "Pendiente"],
    CANCELADA: ["bg-pista text-tinta-muted", "Cancelada"],
  };
  const [clases, texto] = estilos[estado];
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs ${clases}`}>{texto}</span>
  );
}

function IconoSilla() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 11V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5M5 11a2 2 0 1 0 0 4h14a2 2 0 1 0 0-4M5 11v0m14 0v0M6 15v4m12-4v4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
