/**
 * Reloj que ve el cliente, separado del tiempo real del relé.
 *
 * La masajeadora arranca su propio programa cada vez que recibe corriente y
 * espera que alguien presione START. Por eso:
 *
 *  - Al encender se le suma una gracia de inicio (`graciaInicioSeg`) para que
 *    el cliente se siente y presione START. El cliente no la ve: el reloj
 *    queda congelado en la duración contratada (ej. 10:00) mientras dura, y
 *    recién después empieza a bajar.
 *  - Al terminar viene la fase SALIDA: unos segundos con la silla apagada
 *    (PAUSA) y después un pulso de corriente (RETORNO) para que, presionando
 *    START, la silla vuelva a la posición vertical y el cliente pueda salir.
 *
 * Función pura para que la usen tanto SesionesService como SillasService
 * (que no pueden importarse entre sí sin crear un ciclo).
 */
export type FaseReloj = 'GRACIA' | 'MASAJE' | 'PAUSA' | 'RETORNO';

export interface DatosReloj {
  estado: string;
  duracionMin: number;
  retornoSeg: number;
  finProgramado: Date | null;
  salidaHasta: Date | null;
}

export interface Reloj {
  /** Segundos del masaje que ve el cliente (nunca más que la duración). */
  segundosRestantes: number | null;
  fase: FaseReloj | null;
  /** En SALIDA: segundos hasta que termine la sub-fase actual. */
  segundosSalida: number | null;
  /**
   * En SALIDA: segundos hasta que el sillón quede libre (pausa + retorno).
   * Es lo que ve quien espera: un solo número que baja, sin el salto de la
   * pausa al retorno que tiene `segundosSalida`.
   */
  segundosParaLiberar: number | null;
}

export function calcularReloj(s: DatosReloj, ahora: number = Date.now()): Reloj {
  if (s.estado === 'ACTIVA' && s.finProgramado) {
    const real = Math.max(0, Math.round((s.finProgramado.getTime() - ahora) / 1000));
    const contratado = s.duracionMin * 60;
    return {
      segundosRestantes: Math.min(real, contratado),
      fase: real > contratado ? 'GRACIA' : 'MASAJE',
      segundosSalida: null,
      segundosParaLiberar: null,
    };
  }
  if (s.estado === 'SALIDA' && s.salidaHasta) {
    const resto = Math.max(0, Math.round((s.salidaHasta.getTime() - ahora) / 1000));
    const enPausa = resto > s.retornoSeg;
    return {
      segundosRestantes: 0,
      fase: enPausa ? 'PAUSA' : 'RETORNO',
      segundosSalida: enPausa ? resto - s.retornoSeg : resto,
      segundosParaLiberar: resto,
    };
  }
  return {
    segundosRestantes: null,
    fase: null,
    segundosSalida: null,
    segundosParaLiberar: null,
  };
}
