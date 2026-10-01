import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
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
} from './silla.constraints';

export class ActualizarSillaDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(NOMBRE_MAX_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  nombre?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(PRECIO_MAXIMO)
  precio?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  duracionMin?: number;

  /** Cambiar el dispositivo Shelly vinculado (revalida modelo). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(12)
  @Matches(DEVICE_ID_SHELLY_REGEX, { message: DEVICE_ID_SHELLY_MENSAJE })
  deviceIdShelly?: string;

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

export class ActivarManualDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  duracionMin?: number;
}
