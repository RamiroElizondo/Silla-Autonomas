import type {
  ActualizarSillaPayload,
  CanjeRespuesta,
  CheckoutRespuesta,
  ColaResumen,
  CrearSillaPayload,
  CreditoAdmin,
  EstadoPublico,
  EstadoSesionPublico,
  EstadoTurnoPublico,
  HistorialRespuesta,
  PagoRevision,
  ResolverPagoPayload,
  ResultadoPrueba,
  SillaAdmin,
  TurnoCheckoutRespuesta,
  UsuarioAdmin,
  VerificacionDispositivo,
} from "./tipos";

import { parsearRetryAfter } from "./polling";

// Same-origin: todo pasa por el proxy /api del propio Next.js (ver
// src/app/api/[...path]/route.ts), que reenvía al backend real. Así el
// navegador nunca hace un pedido cross-origin y no hace falta CORS ni
// exponer el backend con su propio túnel.
const API_URL = "/api";

/**
 * Header que el proxy exige en todo no-GET a /api/admin/* (protección CSRF,
 * ver route.ts): un <form> cross-site no puede agregarlo, una fetch
 * same-origin sí.
 */
const CSRF_HEADER = "X-Requested-With";
const CSRF_HEADER_VALOR = "sillas-admin";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * Milisegundos que pidió esperar el header `Retry-After` de un 429, o
     * `undefined` si no vino (o la respuesta no fue un 429). Lo usan los
     * hooks de polling para atrasar el próximo sondeo (`proximoRetrasoMs`)
     * en vez de reintentar al ritmo normal.
     */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const metodo = (init.method ?? "GET").toUpperCase();
  const esEscrituraAdmin = path.startsWith("/admin") && metodo !== "GET";

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(esEscrituraAdmin ? { [CSRF_HEADER]: CSRF_HEADER_VALOR } : {}),
      ...init.headers,
    },
    // La sesión admin vive en una cookie httpOnly (ver route.ts): el
    // navegador la manda solo porque el pedido es same-origin, no hace
    // falta "Authorization" ni tocar nada acá para eso.
    cache: "no-store",
  });

  if (!res.ok) {
    // Leído ANTES de tirar: una vez que se lanza la excepción no hay forma
    // de volver a mirar la respuesta.
    const retryAfterMs =
      res.status === 429
        ? (parsearRetryAfter(res.headers.get("retry-after")) ?? undefined)
        : undefined;

    let mensaje = `Error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message)
        mensaje = Array.isArray(body.message)
          ? body.message.join(", ")
          : body.message;
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    throw new ApiError(res.status, mensaje, retryAfterMs);
  }
  // Tolerar respuestas sin cuerpo (ej: acciones que devuelven 200 vacío)
  const texto = await res.text();
  return (texto ? JSON.parse(texto) : undefined) as T;
}

/* ---------- Público (landing + TV) ---------- */

export function obtenerEstado(sillaId: string) {
  return request<EstadoPublico>(`/sillas/${sillaId}/estado`);
}

/**
 * Estado de la sesión propia del cliente. El estado de la silla no alcanza:
 * si un corte corta la sesión, la silla vuelve a estar libre para otro y esta
 * es la única pantalla donde el cliente ve su vale.
 */
export function obtenerEstadoSesion(sesionId: string) {
  return request<EstadoSesionPublico>(`/sesiones/${sesionId}/estado`);
}

export function iniciarCheckout(sillaId: string, turnstileToken?: string | null) {
  // Le pasamos al backend el origin público actual (el dominio del túnel,
  // o localhost en dev) para que arme los back_urls de Mercado Pago, y el
  // token de Turnstile del widget del botón de pagar (ver TurnstileWidget).
  const origin = typeof window !== "undefined" ? window.location.origin : undefined;
  return request<CheckoutRespuesta>(`/sillas/${sillaId}/checkout`, {
    method: "POST",
    body: JSON.stringify({
      ...(origin ? { origin } : {}),
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });
}

/**
 * Respaldo del Webhook al volver de Checkout Pro. El backend no confía en
 * estos parámetros: consulta el paymentId directamente a Mercado Pago.
 */
export function confirmarPagoRetorno(sillaId: string, paymentId: string) {
  return request<{ ok: boolean }>(`/sillas/${sillaId}/confirmar-pago`, {
    method: "POST",
    body: JSON.stringify({ paymentId }),
  });
}

/**
 * Libera la silla al toque cuando el cliente cancela/abandona el pago en
 * MP y vuelve a `/fracaso`, en vez de esperar el timeout de 3 min. Best
 * effort: si falla, el timeout del backend la libera igual más tarde.
 */
export function cancelarPago(sillaId: string, sesionId: string) {
  return request<{ ok: boolean }>(`/sillas/${sillaId}/cancelar-pago`, {
    method: "POST",
    body: JSON.stringify({ sesionId }),
  });
}

/* ---------- Admin ---------- */
//
// El JWT ya no pasa por el navegador (Bloque A del hardening): vive en una
// cookie httpOnly que pone y lee el proxy (route.ts). Estas funciones no
// reciben ni devuelven ningún token; la sesión se consulta con
// `verificarSesion()` (GET /admin/auth/me) y se cierra con `cerrarSesion()`.

export async function login(email: string, password: string): Promise<void> {
  await request<{ ok: boolean }>(`/admin/auth/login`, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

/** null si no hay sesión (o venció/fue revocada); tira en cualquier otro error. */
export async function verificarSesion(): Promise<UsuarioAdmin | null> {
  try {
    return await request<UsuarioAdmin>(`/admin/auth/me`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function cerrarSesion() {
  return request<{ ok: boolean }>(`/admin/auth/logout`, { method: "POST" });
}

export function obtenerSillasAdmin() {
  return request<SillaAdmin[]>(`/admin/sillas`);
}

export function obtenerHistorial(take = 50, skip = 0) {
  return request<HistorialRespuesta>(`/admin/sesiones?take=${take}&skip=${skip}`);
}

/**
 * Verifica un device Shelly puntual contra la nube (existe / online / modelo).
 * La Cloud Control API v2 no permite listar los dispositivos de la cuenta,
 * así que el alta de sillas se hace ingresando el ID y validándolo acá.
 */
export function verificarDispositivo(deviceId: string) {
  return request<VerificacionDispositivo>(
    `/admin/shelly/dispositivos/${encodeURIComponent(deviceId)}`,
  );
}

export function crearSilla(payload: CrearSillaPayload) {
  return request<SillaAdmin>(`/admin/sillas`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function actualizarSilla(sillaId: string, payload: ActualizarSillaPayload) {
  return request<SillaAdmin>(`/admin/sillas/${sillaId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/** Vales emitidos por cortes de energía. */
export function obtenerCreditos(take = 50) {
  return request<CreditoAdmin[]>(`/admin/creditos?take=${take}`);
}

/** Prueba de conexión con el Shelly de la silla (estado al momento). */
export function probarSilla(sillaId: string) {
  return request<ResultadoPrueba>(`/admin/sillas/${sillaId}/probar`);
}

/** Activación manual sin pago (cortesía / prueba). */
export function activarManual(sillaId: string) {
  return request(`/admin/sillas/${sillaId}/activar`, { method: "POST" });
}

/** Parada de emergencia: corta la sesión activa y apaga el relé. */
export function pararEmergencia(sillaId: string) {
  return request(`/admin/sillas/${sillaId}/detener`, { method: "POST" });
}

/**
 * Pagos aprobados que no activaron ningún servicio, o que Mercado Pago
 * marcó refunded/charged_back/cancelled después de aprobados (Bloque B).
 * Solo trae los pendientes de resolver.
 */
export function obtenerPagosRevision(take = 50) {
  return request<PagoRevision[]>(`/admin/pagos/revision?take=${take}`);
}

/** Resuelve a mano un pago marcado para revisión. Idempotente. */
export function resolverPago(pagoId: string, payload: ResolverPagoPayload) {
  return request<PagoRevision>(`/admin/pagos/${pagoId}/resolver`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/* ---------- Cola compartida ---------- */

/** Resumen para mostrar en la landing de una silla ocupada. */
export function obtenerResumenCola() {
  return request<ColaResumen>(`/cola/estado`);
}

export function unirseCola(turnstileToken?: string | null) {
  const origin = typeof window !== "undefined" ? window.location.origin : undefined;
  return request<TurnoCheckoutRespuesta>(`/cola/checkout`, {
    method: "POST",
    body: JSON.stringify({
      ...(origin ? { origin } : {}),
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });
}

export function confirmarPagoTurnoRetorno(turnoId: string, paymentId: string) {
  return request<{ ok: boolean }>(`/cola/${turnoId}/confirmar-pago`, {
    method: "POST",
    body: JSON.stringify({ paymentId }),
  });
}

export function obtenerEstadoTurno(turnoId: string) {
  return request<EstadoTurnoPublico>(`/cola/${turnoId}/estado`);
}

/** Best effort — si falla, el timeout del backend cancela el turno igual. */
export function cancelarTurno(turnoId: string) {
  return request<{ ok: boolean }>(`/cola/${turnoId}/cancelar`, { method: "POST" });
}

/** Canjea un vale por corte de energía: vuelve a la cola sin pagar de nuevo. */
export function canjearCredito(codigo: string) {
  return request<CanjeRespuesta>(`/cola/canjear`, {
    method: "POST",
    body: JSON.stringify({ codigo }),
  });
}

/** El cliente confirma presencia cuando le toca la silla asignada. */
export function confirmarTurno(turnoId: string) {
  return request<{ ok: boolean; sillaId: string }>(`/cola/${turnoId}/confirmar`, {
    method: "POST",
  });
}

export { ApiError };
