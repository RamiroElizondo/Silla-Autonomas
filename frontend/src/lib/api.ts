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
  ResultadoPrueba,
  SillaAdmin,
  TurnoCheckoutRespuesta,
  VerificacionDispositivo,
} from "./tipos";

// Same-origin: todo pasa por el proxy /api del propio Next.js (ver
// src/app/api/[...path]/route.ts), que reenvía al backend real. Así el
// navegador nunca hace un pedido cross-origin y no hace falta CORS ni
// exponer el backend con su propio túnel.
const API_URL = "/api";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });

  if (!res.ok) {
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
    throw new ApiError(res.status, mensaje);
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

export function login(email: string, password: string) {
  return request<{ token: string }>(`/admin/auth/login`, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function obtenerSillasAdmin(token: string) {
  return request<SillaAdmin[]>(`/admin/sillas`, {}, token);
}

export function obtenerHistorial(token: string, take = 50, skip = 0) {
  return request<HistorialRespuesta>(
    `/admin/sesiones?take=${take}&skip=${skip}`,
    {},
    token,
  );
}

/**
 * Verifica un device Shelly puntual contra la nube (existe / online / modelo).
 * La Cloud Control API v2 no permite listar los dispositivos de la cuenta,
 * así que el alta de sillas se hace ingresando el ID y validándolo acá.
 */
export function verificarDispositivo(token: string, deviceId: string) {
  return request<VerificacionDispositivo>(
    `/admin/shelly/dispositivos/${encodeURIComponent(deviceId)}`,
    {},
    token,
  );
}

export function crearSilla(token: string, payload: CrearSillaPayload) {
  return request<SillaAdmin>(
    `/admin/sillas`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export function actualizarSilla(
  token: string,
  sillaId: string,
  payload: ActualizarSillaPayload,
) {
  return request<SillaAdmin>(
    `/admin/sillas/${sillaId}`,
    { method: "PATCH", body: JSON.stringify(payload) },
    token,
  );
}

/** Vales emitidos por cortes de energía. */
export function obtenerCreditos(token: string, take = 50) {
  return request<CreditoAdmin[]>(`/admin/creditos?take=${take}`, {}, token);
}

/** Prueba de conexión con el Shelly de la silla (estado al momento). */
export function probarSilla(token: string, sillaId: string) {
  return request<ResultadoPrueba>(`/admin/sillas/${sillaId}/probar`, {}, token);
}

/** Activación manual sin pago (cortesía / prueba). */
export function activarManual(token: string, sillaId: string) {
  return request(`/admin/sillas/${sillaId}/activar`, { method: "POST" }, token);
}

/** Parada de emergencia: corta la sesión activa y apaga el relé. */
export function pararEmergencia(token: string, sillaId: string) {
  return request(`/admin/sillas/${sillaId}/detener`, { method: "POST" }, token);
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
