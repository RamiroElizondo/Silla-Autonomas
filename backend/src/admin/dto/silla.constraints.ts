/**
 * Constraints compartidas entre CrearSillaDto y ActualizarSillaDto: se
 * centralizan acá para que un cambio de tope no pueda quedar aplicado en
 * el alta y olvidado en la edición (o viceversa).
 */

/**
 * Formato del device ID de Shelly Cloud: 12 caracteres hexadecimales en
 * minúscula (es el MAC-like ID que usa la Cloud Control API v2 — ver el
 * placeholder "e4b063f1a2c3" en frontend/src/components/FormSilla.tsx, que
 * viene de un device real). Es un chequeo de formato best-effort nada más:
 * no garantiza que el device exista ni esté vinculado — eso lo confirma
 * `AdminService.consultarDispositivo`/`validarDispositivo` contra la API
 * real de Shelly Cloud antes de dar de alta o editar la silla.
 */
export const DEVICE_ID_SHELLY_REGEX = /^[a-f0-9]{12}$/;

export const DEVICE_ID_SHELLY_MENSAJE =
  'deviceIdShelly debe tener el formato de un device Shelly (12 caracteres hexadecimales en minúscula)';

/**
 * Precio máximo por sesión, en ARS. No hay un tope "correcto" del negocio;
 * es una cota generosa (muy por encima de lo que costaría una sesión real
 * de 10 min en una silla masajeadora) pensada solo para atajar un error de
 * tipeo (ej. un cero de más) antes de que llegue a Mercado Pago, no para
 * limitar precios legítimos.
 */
export const PRECIO_MAXIMO = 1_000_000;

/** Duración máxima de una opción de masaje, en minutos. */
export const DURACION_MAXIMA_MIN = 120;

/** Largo máximo del nombre de la silla (se muestra en landing, TV y panel). */
export const NOMBRE_MAX_LENGTH = 80;

/**
 * Topes de los tiempos propios de la masajeadora, en segundos (ver
 * src/sesiones/reloj.util.ts). 0 desactiva la fase. Las cotas solo atajan
 * errores de tipeo: un pulso de retorno largo hace que la silla arranque
 * otra pasada y se vuelva a acostar.
 */
export const GRACIA_INICIO_MAX_SEG = 120;
export const PAUSA_RETORNO_MAX_SEG = 60;
export const RETORNO_MAX_SEG = 120;
