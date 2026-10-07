import { obtenerEstadoSesion } from "./api";
import type { EstadoSesion } from "./tipos";

/**
 * Recuerda la sesión de pago directo del cliente para que, si vuelve a la
 * landing de cualquier sillón (botón atrás, o escaneando de nuevo un QR),
 * lo mandemos a la vista de su turno en vez de a la pantalla de pago.
 *
 * Va en localStorage y no en sessionStorage: al escanear el QR el teléfono
 * suele abrir una pestaña nueva, y Mercado Pago a veces devuelve a otra
 * pestaña o al navegador de su app. localStorage se comparte entre pestañas
 * del mismo navegador (no entre navegadores distintos: eso no se puede).
 */
const CLAVE = "sesionActiva";

/** Estados en los que el cliente todavía está usando (o por usar) el sillón. */
const EN_CURSO: EstadoSesion[] = [
  "ESPERANDO_CONFIRMACION",
  "ESPERANDO_ENERGIA",
  "ACTIVA",
  "SALIDA",
];

type Guardada = { sillaId: string; sesionId: string };

function leer(): Guardada | null {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return null;
    const v = JSON.parse(crudo);
    return typeof v?.sillaId === "string" && typeof v?.sesionId === "string" ? v : null;
  } catch {
    return null;
  }
}

export function recordarSesionActiva(sillaId: string, sesionId: string): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify({ sillaId, sesionId }));
  } catch {
    // sin storage (modo privado estricto): se pierde solo la redirección
  }
}

export function olvidarSesionActiva(sesionId: string): void {
  try {
    if (leer()?.sesionId === sesionId) localStorage.removeItem(CLAVE);
  } catch {
    // idem
  }
}

/**
 * Ruta a la vista del turno en curso, o null si no hay ninguno. Se consulta
 * al backend: lo guardado puede ser viejo, y solo se redirige si la sesión
 * sigue andando. Ante cualquier error, null (mejor mostrar la landing).
 */
export async function rutaSesionActiva(): Promise<string | null> {
  const g = leer();
  if (!g) return null;
  try {
    const sesion = await obtenerEstadoSesion(g.sesionId);
    if (EN_CURSO.includes(sesion.estado)) {
      return `/silla/${g.sillaId}/exito?sesion=${encodeURIComponent(g.sesionId)}`;
    }
    // Pendiente de pago: la dejamos guardada (puede volver de Mercado Pago).
    if (sesion.estado !== "PENDIENTE") olvidarSesionActiva(g.sesionId);
    return null;
  } catch {
    return null;
  }
}
