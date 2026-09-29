"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EstadoBadge } from "@/components/EstadoBadge";
import { FormSilla } from "@/components/FormSilla";
import {
  activarManual,
  cerrarSesion,
  login,
  obtenerColaAdmin,
  obtenerCreditos,
  obtenerHistorial,
  obtenerPagosRevision,
  obtenerSillasAdmin,
  pararEmergencia,
  probarSilla,
  resolverPago,
  verificarSesion,
} from "@/lib/api";
import type {
  CreditoAdmin,
  PagoRevision,
  ResolverPagoPayload,
  ResultadoPrueba,
  SesionAdmin,
  SillaAdmin,
  TurnoColaAdmin,
  UsuarioAdmin,
} from "@/lib/tipos";

export default function Admin() {
  const [sesion, setSesion] = useState<UsuarioAdmin | null>(null);
  const [listo, setListo] = useState(false);

  useEffect(() => {
    // La sesión vive en una cookie httpOnly (Bloque A del hardening): acá
    // no hay ningún token que leer, solo preguntarle al backend si la
    // cookie que mandó el navegador sigue siendo válida.
    verificarSesion()
      .then(setSesion)
      .finally(() => setListo(true));
  }, []);

  if (!listo) return null;

  return sesion ? (
    <Dashboard
      onCerrarSesion={async () => {
        try {
          await cerrarSesion();
        } finally {
          setSesion(null);
        }
      }}
    />
  ) : (
    <Login onLogin={() => verificarSesion().then(setSesion)} />
  );
}

/* ---------- Login ---------- */

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setCargando(true);
    setError(null);
    try {
      await login(email, password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión");
      setCargando(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 sm:px-6">
      <p className="text-xs uppercase tracking-[0.12em] text-tinta-muted">
        Relajá
      </p>
      <h1 className="mt-1.5 text-2xl font-medium">Panel del local</h1>
      <form onSubmit={entrar} className="mt-8 flex flex-col gap-3">
        <input
          type="email"
          required
          placeholder="tu@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-xl border border-borde bg-marfil px-4 py-3.5 text-base outline-none placeholder:text-arena focus:border-borde-fuerte"
        />
        <input
          type="password"
          required
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl border border-borde bg-marfil px-4 py-3.5 text-base outline-none placeholder:text-arena focus:border-borde-fuerte"
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

/** Filas por página en "Últimas operaciones" y "Vales". */
const TAM_PAGINA = 10;

/** Índice (base 0) de la última página para `total` filas. */
function ultimaPagina(total: number) {
  return Math.max(0, Math.ceil(total / TAM_PAGINA) - 1);
}

/**
 * Botones del panel. Mobile primero: alto mínimo de 40 px para que se
 * toquen bien con el pulgar; en pantallas ≥ sm vuelven a su tamaño compacto.
 */
const BTN_BASE =
  "inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-[10px] border px-3.5 py-2 text-[13px] transition disabled:opacity-50 sm:min-h-0 sm:px-3";
const BTN = `${BTN_BASE} border-borde-fuerte text-tinta-suave hover:bg-panal`;
const BTN_PELIGRO = `${BTN_BASE} border-terracota-borde text-terracota-oscuro hover:bg-terracota-claro`;
const BTN_SUAVE = `${BTN_BASE} border-transparent text-tinta-muted hover:bg-panal`;

function formatoFecha(iso: string) {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Dashboard({
  onCerrarSesion,
}: {
  onCerrarSesion: () => void;
}) {
  const [sillas, setSillas] = useState<SillaAdmin[]>([]);
  /** Página visible de "Últimas operaciones". */
  const [sesiones, setSesiones] = useState<SesionAdmin[]>([]);
  const [totalSesiones, setTotalSesiones] = useState(0);
  const [paginaOps, setPaginaOps] = useState(0);
  /** Últimas sesiones, solo para calcular las métricas de arriba. */
  const [recientes, setRecientes] = useState<SesionAdmin[]>([]);
  /** Página visible de "Vales por cortes de energía". */
  const [creditos, setCreditos] = useState<CreditoAdmin[]>([]);
  const [totalCreditos, setTotalCreditos] = useState(0);
  const [paginaVales, setPaginaVales] = useState(0);
  const [pagosRevision, setPagosRevision] = useState<PagoRevision[]>([]);
  const [cola, setCola] = useState<TurnoColaAdmin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [accionando, setAccionando] = useState<string | null>(null);
  /** null = cerrado, "nueva" = alta, SillaAdmin = edición */
  const [form, setForm] = useState<"nueva" | SillaAdmin | null>(null);
  const [pruebas, setPruebas] = useState<
    Record<string, ResultadoPrueba | "cargando" | { error: string }>
  >({});
  const [confirmarParar, setConfirmarParar] = useState<SillaAdmin | null>(null);
  const [resolviendo, setResolviendo] = useState<string | null>(null);
  /** Duración del vale (minutos) para pagos sin sesión/turno asociado. */
  const [duracionVale, setDuracionVale] = useState<Record<string, number>>({});
  /** Para descartar respuestas viejas si el usuario cambia de página mientras carga. */
  const ultimoPedido = useRef(0);

  const cargar = useCallback(async () => {
    const pedido = ++ultimoPedido.current;
    try {
      const [s, r, h, c, pr, co] = await Promise.all([
        obtenerSillasAdmin(),
        obtenerHistorial(50),
        // En la primera página no hace falta un pedido aparte: sale de `recientes`.
        paginaOps === 0
          ? Promise.resolve(null)
          : obtenerHistorial(TAM_PAGINA, paginaOps * TAM_PAGINA),
        obtenerCreditos(TAM_PAGINA, paginaVales * TAM_PAGINA),
        obtenerPagosRevision(50),
        obtenerColaAdmin(),
      ]);
      if (pedido !== ultimoPedido.current) return;
      const ops = h ?? { items: r.items.slice(0, TAM_PAGINA), total: r.total };
      setSillas(s);
      setRecientes(r.items);
      setSesiones(ops.items);
      setTotalSesiones(ops.total);
      setCreditos(c.items);
      setTotalCreditos(c.total);
      setPagosRevision(pr);
      setCola(co);
      // Si la lista se achicó y la página actual ya no existe, volver a la última.
      setPaginaOps((p) => Math.min(p, ultimaPagina(ops.total)));
      setPaginaVales((p) => Math.min(p, ultimaPagina(c.total)));
      setError(null);
    } catch (e) {
      if (pedido !== ultimoPedido.current) return;
      const mensaje = e instanceof Error ? e.message : "Error de conexión";
      if (mensaje.includes("401")) onCerrarSesion();
      setError(mensaje);
    }
  }, [onCerrarSesion, paginaOps, paginaVales]);

  useEffect(() => {
    cargar();
    const id = setInterval(cargar, 5000);
    return () => clearInterval(id);
  }, [cargar]);

  async function probar(sillaId: string) {
    setPruebas((p) => ({ ...p, [sillaId]: "cargando" }));
    try {
      const r = await probarSilla(sillaId);
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
    fn: (id: string) => Promise<unknown>,
  ) {
    setAccionando(sillaId);
    try {
      await fn(sillaId);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La acción falló");
    } finally {
      setAccionando(null);
    }
  }

  /**
   * Resuelve a mano un pago aprobado que no activó ningún servicio, o que se
   * marcó como reembolsado (Bloque B). Para 'emitir_vale' sin sesión ni
   * turno asociado, hace falta indicar la duración a mano (ver `duracionVale`).
   */
  async function resolver(pago: PagoRevision, accion: ResolverPagoPayload["accion"]) {
    setResolviendo(pago.id);
    try {
      const sinReferencia = !pago.sesion && !pago.turno;
      await resolverPago(pago.id, {
        accion,
        duracionMinVale:
          accion === "emitir_vale" && sinReferencia ? duracionVale[pago.id] : undefined,
      });
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo resolver el pago");
    } finally {
      setResolviendo(null);
    }
  }

  const hoy = new Date().toDateString();
  const esteMes = new Date().getMonth();
  const cobradas = recientes.filter(
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
    <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-borde py-4 sm:py-5">
        <div className="flex items-baseline gap-2.5">
          <span className="text-lg font-medium">Relajá</span>
          <span className="text-xs text-tinta-muted">Panel</span>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-tinta-suave">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${shellyOk ? "bg-salvia" : "bg-terracota"}`}
            />
            {shellyOk ? "Shelly conectado" : "Shelly con problemas"}
          </span>
          <button
            onClick={onCerrarSesion}
            className="-my-2.5 px-1 py-2.5 underline underline-offset-4"
          >
            Salir
          </button>
        </div>
      </header>

      {error && (
        <p className="mt-4 rounded-xl bg-terracota-claro px-4 py-3 text-sm text-terracota-oscuro">
          {error}
        </p>
      )}

      <section className="mt-5 grid grid-cols-2 gap-2.5 sm:mt-6 sm:grid-cols-3">
        <Metrica etiqueta="Ingresos hoy" valor={`$${suma(deHoy).toLocaleString("es-AR")}`} />
        <Metrica etiqueta="Sesiones hoy" valor={String(deHoy.length)} />
        <Metrica
          etiqueta="Este mes"
          valor={`$${suma(delMes).toLocaleString("es-AR")}`}
          className="col-span-2 sm:col-span-1"
        />
      </section>

      <div className="mt-8 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-medium text-tinta-suave">Sillas</h2>
        {form === null && (
          <button onClick={() => setForm("nueva")} className={BTN}>
            + Agregar silla
          </button>
        )}
      </div>
      <section className="mt-2.5 flex flex-col gap-2.5">
        {form !== null && (
          <FormSilla
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
            className="relative flex flex-col gap-3.5 rounded-xl border border-borde bg-marfil p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5"
          >
            <div className="absolute right-3 top-3 sm:right-4">
              <EstadoBadge
                estado={silla.estado}
                sinEnergia={silla.salud ? !silla.salud.online : false}
              />
            </div>
            <div className="flex min-w-0 items-start gap-3.5 pr-28 sm:items-center">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-terracota-claro text-terracota">
                <IconoSilla />
              </div>
              <div className="min-w-0">
                <p className="text-[15px] font-medium">{silla.nombre}</p>
                <p className="mt-0.5 break-words text-[13px] text-tinta-muted">
                  ${silla.precio.toLocaleString("es-AR")} · {silla.duracionMin} min
                  {silla.modeloShelly && ` · ${silla.modeloShelly}`}
                  {silla.salud?.potenciaW != null &&
                    ` · consumo ${Math.round(silla.salud.potenciaW)} W`}
                  {silla.salud?.temperaturaC != null &&
                    ` · ${Math.round(silla.salud.temperaturaC)} °C`}
                </p>
                <ResultadoPruebaLinea resultado={pruebas[silla.id]} />
                {silla.salud?.alertas?.map((a) => (
                  <p key={a} className="mt-0.5 break-words text-[13px] text-terracota-oscuro">
                    ⚠ {a}
                  </p>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:gap-2.5">
              <button
                onClick={() => probar(silla.id)}
                disabled={pruebas[silla.id] === "cargando"}
                className={`${BTN} flex-1 sm:flex-none`}
              >
                {pruebas[silla.id] === "cargando" ? "Probando…" : "Probar"}
              </button>
              <button
                onClick={() => setForm(silla)}
                className={`${BTN} flex-1 sm:flex-none`}
              >
                Editar
              </button>
              {silla.estado === "LIBRE" && (
                <button
                  onClick={() => accion(silla.id, activarManual)}
                  disabled={accionando === silla.id}
                  className={`${BTN} flex-1 sm:flex-none`}
                >
                  Activar manual
                </button>
              )}
              {silla.estado === "EN_USO" && (
                <button
                  onClick={() => setConfirmarParar(silla)}
                  disabled={accionando === silla.id}
                  className={`${BTN_PELIGRO} flex-1 sm:flex-none`}
                >
                  Parar
                </button>
              )}
            </div>
          </article>
        ))}
      </section>

      {pagosRevision.length > 0 && (
        <>
          <h2 className="mt-8 text-[13px] font-medium text-tinta-suave">
            Pagos para revisar
          </h2>
          <section className="mt-2.5 flex flex-col gap-2.5">
            {pagosRevision.map((p) => {
              const sinReferencia = !p.sesion && !p.turno;
              return (
                <article
                  key={p.id}
                  className="flex flex-col gap-3 rounded-xl border border-terracota-borde bg-terracota-claro p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                >
                  <div className="min-w-0">
                    <p className="text-[15px] font-medium">
                      ${p.monto.toLocaleString("es-AR")}
                      {p.sesion?.silla && ` · ${p.sesion.silla.nombre}`}
                      {sinReferencia && p.turno?.codigo && ` · Turno ${p.turno.codigo}`}
                    </p>
                    <p className="mt-0.5 text-[13px] text-terracota-oscuro">
                      {MOTIVOS_REVISION[p.motivoRevision ?? ""] ??
                        p.motivoRevision ??
                        "Sin motivo registrado"}
                      {" · "}
                      {formatoFecha(p.recibidoEn)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {sinReferencia && (
                      <input
                        type="number"
                        min={1}
                        max={120}
                        placeholder="min"
                        aria-label="Duración del vale en minutos"
                        value={duracionVale[p.id] ?? ""}
                        onChange={(e) =>
                          setDuracionVale((d) => ({ ...d, [p.id]: Number(e.target.value) }))
                        }
                        className="min-h-10 w-20 rounded-[10px] border border-borde bg-marfil px-2 py-2 text-base outline-none focus:border-borde-fuerte sm:min-h-0 sm:text-[13px]"
                      />
                    )}
                    <button
                      onClick={() => resolver(p, "emitir_vale")}
                      disabled={
                        resolviendo === p.id || (sinReferencia && !duracionVale[p.id])
                      }
                      className={`${BTN} flex-1 sm:flex-none`}
                    >
                      Emitir vale
                    </button>
                    <button
                      onClick={() => resolver(p, "marcar_reembolsado")}
                      disabled={resolviendo === p.id}
                      className={`${BTN} flex-1 sm:flex-none`}
                    >
                      Ya reembolsé
                    </button>
                    <button
                      onClick={() => resolver(p, "ignorar")}
                      disabled={resolviendo === p.id}
                      className={`${BTN_SUAVE} flex-1 sm:flex-none`}
                    >
                      Ignorar
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        </>
      )}

      {cola.length > 0 && (
        <>
          <h2 className="mt-8 text-[13px] font-medium text-tinta-suave">
            En cola ({cola.length})
          </h2>
          <section className="mt-2.5 overflow-hidden rounded-xl border border-borde bg-marfil">
            <ul className="divide-y divide-borde-suave text-[13px]">
              {cola.map((t, i) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <span className="text-sm font-medium">
                      {t.estado === "ASIGNADO"
                        ? `Silla asignada: ${t.silla?.nombre ?? "—"}`
                        : `Turno ${i + 1} en la fila`}
                    </span>
                    <p className="mt-0.5 text-tinta-muted">
                      {t.codigo ? `${t.codigo} · ` : ""}
                      {t.duracionMin} min · $
                      {Number(t.monto).toLocaleString("es-AR")}
                      {t.pagadoEn ? ` · pagó ${formatoFecha(t.pagadoEn)}` : ""}
                    </p>
                  </div>
                  <span className="whitespace-nowrap rounded-full bg-panal px-2.5 py-1 text-xs text-tinta-suave">
                    {t.estado === "ASIGNADO" ? "Por confirmar" : "Esperando silla"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <h2 className="mt-8 text-[13px] font-medium text-tinta-suave">
        Últimas operaciones
      </h2>
      <section className="mt-2.5 overflow-hidden rounded-xl border border-borde bg-marfil">
        {sesiones.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-tinta-muted">
            Sin operaciones todavía
          </p>
        ) : (
          <>
            {/* Mobile: una tarjeta por operación */}
            <ul className="divide-y divide-borde-suave text-[13px] sm:hidden">
              {sesiones.map((s) => {
                const detalle = textoDetalleSesion(s);
                return (
                  <li key={s.id} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium">{s.silla?.nombre ?? "—"}</span>
                      <span className="tabular-nums">
                        {s.esManual ? "Manual" : `$${Number(s.monto).toLocaleString("es-AR")}`}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-3">
                      <span className="text-tinta-suave">{formatoFecha(s.creadaEn)}</span>
                      <BadgeSesion estado={s.estado} />
                    </div>
                    {detalle && <p className="mt-1.5 text-tinta-muted">{detalle}</p>}
                  </li>
                );
              })}
            </ul>
            {/* Tablet / escritorio: tabla */}
            <table className="hidden w-full text-[13px] sm:table">
              <thead>
                <tr className="text-left text-tinta-muted">
                  <th className="px-4 py-2.5 font-medium">Fecha</th>
                  <th className="px-2 py-2.5 font-medium">Silla</th>
                  <th className="px-2 py-2.5 font-medium">Monto</th>
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                  <th className="px-4 py-2.5 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {sesiones.map((s) => (
                  <tr key={s.id} className="border-t border-borde-suave">
                    <td className="px-4 py-2.5 text-tinta-suave">{formatoFecha(s.creadaEn)}</td>
                    <td className="px-2 py-2.5">{s.silla?.nombre ?? "—"}</td>
                    <td className="px-2 py-2.5">
                      {s.esManual ? "Manual" : `$${Number(s.monto).toLocaleString("es-AR")}`}
                    </td>
                    <td className="px-4 py-2.5">
                      <BadgeSesion estado={s.estado} />
                    </td>
                    <td className="px-4 py-2.5 text-tinta-muted">
                      {textoDetalleSesion(s) || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <Paginador pagina={paginaOps} total={totalSesiones} onCambiar={setPaginaOps} />
      </section>

      <h2 className="mt-8 text-[13px] font-medium text-tinta-suave">
        Vales por cortes de energía
      </h2>
      <section className="mt-2.5 overflow-hidden rounded-xl border border-borde bg-marfil">
        {creditos.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-tinta-muted">
            Ningún corte dejó vales pendientes
          </p>
        ) : (
          <>
            {/* Mobile: una tarjeta por vale */}
            <ul className="divide-y divide-borde-suave text-[13px] sm:hidden">
              {creditos.map((c) => (
                <li key={c.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium tabular-nums">{c.codigo}</span>
                    <BadgeCredito credito={c} />
                  </div>
                  <p className="mt-1.5 text-tinta-suave">
                    {c.sesionOrigen?.silla?.nombre ?? "—"} · {c.duracionMin} min
                  </p>
                  <p className="mt-0.5 text-tinta-muted">
                    Emitido {formatoFecha(c.creadoEn)}
                  </p>
                </li>
              ))}
            </ul>
            {/* Tablet / escritorio: tabla */}
            <table className="hidden w-full text-[13px] sm:table">
              <thead>
                <tr className="text-left text-tinta-muted">
                  <th className="px-4 py-2.5 font-medium">Código</th>
                  <th className="px-2 py-2.5 font-medium">Silla</th>
                  <th className="px-2 py-2.5 font-medium">Minutos</th>
                  <th className="px-2 py-2.5 font-medium">Emitido</th>
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {creditos.map((c) => (
                  <tr key={c.id} className="border-t border-borde-suave">
                    <td className="px-4 py-2.5 font-medium tabular-nums">{c.codigo}</td>
                    <td className="px-2 py-2.5">{c.sesionOrigen?.silla?.nombre ?? "—"}</td>
                    <td className="px-2 py-2.5 tabular-nums">{c.duracionMin}</td>
                    <td className="px-2 py-2.5 text-tinta-suave">{formatoFecha(c.creadoEn)}</td>
                    <td className="px-4 py-2.5">
                      <BadgeCredito credito={c} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <Paginador pagina={paginaVales} total={totalCreditos} onCambiar={setPaginaVales} />
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-tinta/25 px-4 backdrop-blur-[2px]"
      onClick={onCancelar}
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-borde bg-marfil p-5 shadow-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[17px] font-medium">{titulo}</h3>
        <p className="mt-2 text-sm leading-relaxed text-tinta-suave">{mensaje}</p>
        <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
          <button onClick={onCancelar} className={BTN}>
            Cancelar
          </button>
          <button
            onClick={onConfirmar}
            className="inline-flex min-h-10 items-center justify-center rounded-[10px] bg-terracota px-4 py-2.5 text-[13px] font-medium text-terracota-claro transition hover:bg-terracota-hover sm:min-h-0"
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
    <>
      <p className="mt-0.5 text-[13px] text-salvia-oscuro">
        ✓ Online · relé{" "}
        {resultado.releEncendido === true
          ? "encendido"
          : resultado.releEncendido === false
            ? "apagado"
            : "sin datos"}
        {resultado.potenciaW != null && ` · ${Math.round(resultado.potenciaW)} W`}
        {resultado.temperaturaC != null &&
          ` · ${Math.round(resultado.temperaturaC)} °C`}
        {resultado.initialState === "off" && " · al volver la luz queda apagada"}
      </p>
      {resultado.advertencia && (
        <p className="mt-0.5 text-[13px] text-terracota-oscuro">
          ⚠ {resultado.advertencia}
        </p>
      )}
    </>
  );
}

function Metrica({
  etiqueta,
  valor,
  className = "",
}: {
  etiqueta: string;
  valor: string;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-borde bg-marfil px-4 py-3.5 ${className}`}>
      <p className="text-xs text-tinta-muted">{etiqueta}</p>
      <p className="mt-1 break-words text-2xl font-medium tabular-nums">{valor}</p>
    </div>
  );
}

/**
 * Pie de tarjeta con Anterior / Siguiente. No se muestra si todo entra en
 * una sola página.
 */
function Paginador({
  pagina,
  total,
  onCambiar,
}: {
  pagina: number;
  total: number;
  onCambiar: (pagina: number) => void;
}) {
  if (total <= TAM_PAGINA) return null;
  const ultima = ultimaPagina(total);
  const desde = pagina * TAM_PAGINA + 1;
  const hasta = Math.min(total, (pagina + 1) * TAM_PAGINA);
  return (
    <nav
      aria-label="Paginación"
      className="flex items-center justify-between gap-2 border-t border-borde-suave px-3 py-2.5"
    >
      <button
        type="button"
        onClick={() => onCambiar(pagina - 1)}
        disabled={pagina <= 0}
        className={BTN}
      >
        ‹ Anterior
      </button>
      <p className="text-center text-xs leading-tight text-tinta-muted tabular-nums">
        <span className="block text-[13px] text-tinta-suave">
          Pág. {pagina + 1} de {ultima + 1}
        </span>
        {desde}–{hasta} de {total}
      </p>
      <button
        type="button"
        onClick={() => onCambiar(pagina + 1)}
        disabled={pagina >= ultima}
        className={BTN}
      >
        Siguiente ›
      </button>
    </nav>
  );
}

/** Motivos de revisión de pagos (Bloque B), en castellano para el dueño. */
const MOTIVOS_REVISION: Record<string, string> = {
  moneda_no_ars: "Pagó en otra moneda",
  monto_insuficiente: "Pagó de menos",
  sesion_no_pendiente: "La reserva ya había vencido cuando llegó el pago",
  turno_no_pendiente: "El turno ya había vencido cuando llegó el pago",
  external_reference_desconocido: "No se pudo identificar a qué correspondía",
  pago_refunded: "Mercado Pago lo marcó como reembolsado",
  pago_charged_back: "El banco hizo un contracargo",
  pago_cancelled: "Mercado Pago lo canceló",
};

/** Motivos de cierre en castellano, para no mostrarle snake_case al dueño. */
const MOTIVOS: Record<string, string> = {
  tiempo_cumplido: "Terminó normal",
  completada_tras_reinicio: "Cerrada al reiniciar",
  pago_no_recibido: "No pagó",
  parada_de_emergencia: "Parada de emergencia",
  corte_de_energia: "Corte de luz",
  corte_sobre_el_final: "Corte sobre el final",
  sin_energia_al_pagar: "Sin luz al momento del pago",
};

function textoDetalleSesion(sesion: SesionAdmin): string {
  const partes: string[] = [];
  if (sesion.motivoCierre) {
    partes.push(MOTIVOS[sesion.motivoCierre] ?? sesion.motivoCierre);
  }
  if (sesion.cortes > 0) {
    const min = Math.round(sesion.segundosCompensados / 60);
    partes.push(
      `${sesion.cortes} corte(s)` +
        (sesion.segundosCompensados > 0 ? ` · +${min || "<1"} min devueltos` : ""),
    );
  }
  return partes.join(" · ");
}

function BadgeCredito({ credito }: { credito: CreditoAdmin }) {
  const estilos: Record<CreditoAdmin["estado"], [string, string]> = {
    DISPONIBLE: ["bg-terracota-claro text-terracota-oscuro", "Sin usar"],
    CANJEADO: ["bg-salvia-claro text-salvia-oscuro", "Usado"],
    VENCIDO: ["bg-pista text-tinta-muted", "Vencido"],
  };
  const [clases, texto] = estilos[credito.estado];
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs ${clases}`}>{texto}</span>
  );
}

function BadgeSesion({ estado }: { estado: SesionAdmin["estado"] }) {
  const estilos: Record<SesionAdmin["estado"], [string, string]> = {
    ACTIVA: ["bg-terracota-claro text-terracota-oscuro", "Activa"],
    COMPLETADA: ["bg-salvia-claro text-salvia-oscuro", "Completada"],
    PENDIENTE: ["bg-panal text-tinta-suave", "Pendiente"],
    ESPERANDO_CONFIRMACION: ["bg-panal text-tinta-suave", "Esperando al cliente"],
    ESPERANDO_ENERGIA: ["bg-panal text-tinta-suave", "Esperando luz"],
    CANCELADA: ["bg-pista text-tinta-muted", "Cancelada"],
  };
  const [clases, texto] = estilos[estado];
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs ${clases}`}>{texto}</span>
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
