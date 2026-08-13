import type {
  ActualizarSillaPayload,
  CheckoutRespuesta,
  ColaResumen,
  CrearSillaPayload,
  DispositivoCloud,
  EstadoPublico,
  EstadoTurnoPublico,
  HistorialRespuesta,
  ResultadoPrueba,
  SillaAdmin,
  TurnoCheckoutRespuesta,
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

export function iniciarCheckout(sillaId: string) {
  // Le pasamos al backend el origin público actual (el dominio del túnel,
  // o localhost en dev) para que arme ahí mismo el notification_url del
  // webhook y los back_urls de MP, sin depender de un env var fijo.
  const origin = typeof window !== "undefined" ? window.location.origin : undefined;
  return request<CheckoutRespuesta>(`/sillas/${sillaId}/checkout`, {
    method: "POST",
    body: JSON.stringify(origin ? { origin } : {}),
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

/** Dispositivos Shelly de la cuenta cloud, para el alta de sillas. */
export function listarDispositivos(token: string) {
  return request<DispositivoCloud[]>(`/admin/shelly/dispositivos`, {}, token);
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

export function unirseCola() {
  const origin = typeof window !== "undefined" ? window.location.origin : undefined;
  return request<TurnoCheckoutRespuesta>(`/cola/checkout`, {
    method: "POST",
    body: JSON.stringify(origin ? { origin } : {}),
  });
}

export function obtenerEstadoTurno(turnoId: string) {
  return request<EstadoTurnoPublico>(`/cola/${turnoId}/estado`);
}

/** Best effort — si falla, el timeout del backend cancela el turno igual. */
export function cancelarTurno(turnoId: string) {
  return request<{ ok: boolean }>(`/cola/${turnoId}/cancelar`, { method: "POST" });
}

/** El cliente confirma presencia cuando le toca la silla asignada. */
export function confirmarTurno(turnoId: string) {
  return request<{ ok: boolean; sillaId: string }>(`/cola/${turnoId}/confirmar`, {
    method: "POST",
  });
}

export { ApiError };
