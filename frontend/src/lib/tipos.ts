export type EstadoSilla =
  | "LIBRE"
  | "PAGO_PENDIENTE"
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
