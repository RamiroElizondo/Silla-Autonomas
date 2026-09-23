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
}

export class ActivarManualDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  duracionMin?: number;
}
