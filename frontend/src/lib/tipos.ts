export type EstadoSilla =
  | "LIBRE"
  | "PAGO_PENDIENTE"
  | "RESERVADA"
  | "EN_USO"
  | "FUERA_DE_SERVICIO";

/** Respuesta de GET /sillas/:id/estado */
export interface EstadoPublico {
  id: string;
  nombre: string;
  estado: EstadoSilla;
  precio: number;
  duracionMin: number;
  segundosRestantes: number | null;
}

/** Respuesta de POST /sillas/:id/checkout */
export interface CheckoutRespuesta {
  sesionId: string;
  initPoint: string;
}

export interface SaludSilla {
  sillaId: string;
  nombre: string;
  deviceId: string;
  online: boolean;
  releEncendido: boolean | null;
  potenciaW: number | null;
  alertas: string[];
  ultimoChequeo: string;
}

/** Item de GET /admin/sillas */
export interface SillaAdmin {
  id: string;
  nombre: string;
  estado: EstadoSilla;
  precio: number;
  duracionMin: number;
  deviceIdShelly: string;
  modeloShelly: string | null;
  finSesionActual: string | null;
  creadaEn: string;
  salud: SaludSilla | null;
}

/** Item de GET /admin/shelly/dispositivos */
export interface DispositivoCloud {
  deviceId: string;
  online: boolean;
  modelo: string | null;
  generacion: string | null;
}

/** Payload de POST /admin/sillas */
export interface CrearSillaPayload {
  nombre: string;
  precio: number;
  duracionMin: number;
  deviceIdShelly: string;
}

/** Payload de PATCH /admin/sillas/:id (todos opcionales) */
export type ActualizarSillaPayload = Partial<CrearSillaPayload>;

/** Respuesta de GET /admin/sillas/:id/probar */
export interface ResultadoPrueba {
  online: boolean;
  releEncendido?: boolean | null;
  potenciaW?: number | null;
  modelo?: string | null;
}

export type EstadoSesion = "PENDIENTE" | "ACTIVA" | "COMPLETADA" | "CANCELADA";

/** Item de GET /admin/sesiones */
export interface SesionAdmin {
  id: string;
  sillaId: string;
  estado: EstadoSesion;
  monto: number;
  duracionMin: number;
  esManual: boolean;
  creadaEn: string;
  inicio: string | null;
  finProgramado: string | null;
  finReal: string | null;
  motivoCierre: string | null;
  silla?: { nombre: string };
}

export interface HistorialRespuesta {
  items: SesionAdmin[];
  total: number;
}

/* ---------- Cola compartida ---------- */

export type EstadoTurno =
  | "ESPERANDO_PAGO"
  | "EN_COLA"
  | "ASIGNADO"
  | "EN_USO"
  | "COMPLETADA"
  | "CANCELADA";

/** Respuesta de GET /cola/estado */
export interface ColaResumen {
  enCola: number;
  sillasLibres: number;
  sillasTotal: number;
}

/** Respuesta de POST /cola/checkout */
export interface TurnoCheckoutRespuesta {
  turnoId: string;
  initPoint: string;
}

/** Respuesta de GET /cola/:id/estado */
export interface EstadoTurnoPublico {
  id: string;
  codigo: string | null;
  estado: EstadoTurno;
  posicion: number | null;
  sillasLibres: number | null;
  sillaAsignada: { id: string; nombre: string } | null;
  segundosVentana: number | null;
  segundosRestantesSesion: number | null;
  duracionMin: number;
}
