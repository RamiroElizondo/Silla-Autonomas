/** Respuesta de GET /admin/auth/me */
export interface UsuarioAdmin {
  id: string;
  email: string;
}

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
  /** El Shelly no responde: casi siempre corte de luz en el local. */
  sinEnergia: boolean;
}

/** Vale por tiempo pagado que no se pudo prestar (corte de energía). */
export interface CreditoPublico {
  codigo: string;
  duracionMin: number;
  estado: "DISPONIBLE" | "CANJEADO" | "VENCIDO";
  venceEn: string;
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
  /** Temperatura interna del relé en °C, si el modelo la reporta */
  temperaturaC: number | null;
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

/** Dispositivo Shelly tal como lo devuelve la Cloud Control API v2 */
export interface DispositivoCloud {
  deviceId: string;
  online: boolean;
  modelo: string | null;
  generacion: string | null;
  releEncendido: boolean | null;
  potenciaW: number | null;
  temperaturaC: number | null;
  midePotencia: boolean;
  /** "off" | "on" | "restore_last" | "match_input" — debe ser "off". */
  initialState: string | null;
}

/** Respuesta de GET /admin/shelly/dispositivos/:deviceId */
export interface VerificacionDispositivo {
  deviceId: string;
  encontrado: boolean;
  /** false si no existe en la cuenta o está offline */
  vinculable: boolean;
  motivo: string | null;
  /** Configuración riesgosa que no impide vincular (ej. initial_state). */
  advertencia: string | null;
  dispositivo: DispositivoCloud | null;
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
  temperaturaC?: number | null;
  modelo?: string | null;
  initialState?: string | null;
  advertencia?: string | null;
}

export type EstadoSesion =
  | "PENDIENTE"
  | "ESPERANDO_ENERGIA"
  | "ACTIVA"
  | "COMPLETADA"
  | "CANCELADA";

/** Respuesta de GET /sesiones/:id/estado (la sesión propia del cliente) */
export interface EstadoSesionPublico {
  id: string;
  estado: EstadoSesion;
  sillaId: string;
  sillaNombre: string;
  duracionMin: number;
  segundosRestantes: number | null;
  /** Corte de energía en curso: la silla está apagada y el reloj, congelado. */
  interrumpida: boolean;
  cortes: number;
  segundosCompensados: number;
  motivoCierre: string | null;
  credito: CreditoPublico | null;
}

/** Respuesta de POST /cola/canjear */
export interface CanjeRespuesta {
  turnoId: string;
  codigo: string;
  duracionMin: number;
}

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
  /** Cortes de energía que tuvo la sesión y segundos devueltos por ellos. */
  cortes: number;
  segundosCompensados: number;
  silla?: { nombre: string };
}

/** Item de GET /admin/creditos */
export interface CreditoAdmin {
  id: string;
  codigo: string;
  estado: "DISPONIBLE" | "CANJEADO" | "VENCIDO";
  duracionMin: number;
  motivo: string;
  creadoEn: string;
  venceEn: string;
  canjeadoEn: string | null;
  sesionOrigen: { id: string; silla: { nombre: string } } | null;
  turnoGenerado: { id: string; codigo: string | null; estado: EstadoTurno } | null;
}

export interface HistorialRespuesta {
  items: SesionAdmin[];
  total: number;
}

/**
 * Item de GET /admin/pagos/revision (Bloque B del hardening): un pago
 * aprobado que no llegó a activar ningún servicio, o que Mercado Pago marcó
 * refunded/charged_back/cancelled después de haber sido aprobado. El dueño
 * lo resuelve a mano con POST /admin/pagos/:id/resolver.
 */
export interface PagoRevision {
  id: string;
  paymentIdMp: string;
  monto: number;
  estado: "PENDIENTE" | "APROBADO" | "RECHAZADO" | "REEMBOLSADO";
  motivoRevision: string | null;
  recibidoEn: string;
  sesion: { id: string; sillaId: string; silla: { nombre: string } } | null;
  turno: { id: string; sillaId: string | null; codigo: string | null } | null;
}

/** Payload de POST /admin/pagos/:id/resolver */
export interface ResolverPagoPayload {
  accion: "emitir_vale" | "marcar_reembolsado" | "ignorar";
  nota?: string;
  /** Obligatorio para 'emitir_vale' cuando el pago no tiene sesión ni turno. */
  duracionMinVale?: number;
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
  sesionEstado: EstadoSesion | null;
  interrumpida: boolean;
  motivoCierre: string | null;
  credito: CreditoPublico | null;
}
