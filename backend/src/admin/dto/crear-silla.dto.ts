import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEVICE_ID_SHELLY_MENSAJE,
  DEVICE_ID_SHELLY_REGEX,
  GRACIA_INICIO_MAX_SEG,
  PAUSA_RETORNO_MAX_SEG,
  RETORNO_MAX_SEG,
  NOMBRE_MAX_LENGTH,
  PRECIO_MAXIMO,
  DURACION_MAXIMA_MIN,
} from './silla.constraints';

export class CrearSillaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(NOMBRE_MAX_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  nombre!: string;

  // Dos opciones de masaje (ver sillas/opciones.util.ts). Las duraciones
  // tienen default en la base (5 y 10 min); los precios son obligatorios.
  // maxDecimalPlaces: 2 porque el precio se cobra en pesos con centavos
  // (no tiene sentido, y Mercado Pago no acepta, más precisión que esa).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(DURACION_MAXIMA_MIN)
  opcion1DuracionMin?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(PRECIO_MAXIMO)
  opcion1Precio!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(DURACION_MAXIMA_MIN)
  opcion2DuracionMin?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(PRECIO_MAXIMO)
  opcion2Precio!: number;

  /** ID del dispositivo en Shelly Cloud (validar con GET /admin/shelly/dispositivos/:deviceId). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(12)
  @Matches(DEVICE_ID_SHELLY_REGEX, { message: DEVICE_ID_SHELLY_MENSAJE })
  deviceIdShelly!: string;

  /** Segundos extra para sentarse y presionar START (el cliente no los ve). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(GRACIA_INICIO_MAX_SEG)
  graciaInicioSeg?: number;

  /** Segundos con la silla apagada entre el fin del turno y el pulso de retorno. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PAUSA_RETORNO_MAX_SEG)
  pausaRetornoSeg?: number;

  /** Segundos de corriente para que la silla vuelva a la posición vertical (0 = sin retorno). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(RETORNO_MAX_SEG)
  retornoSeg?: number;
}
