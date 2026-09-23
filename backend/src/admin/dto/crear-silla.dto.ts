import { Transform } from 'class-transformer';
import {
  IsInt,
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
  NOMBRE_MAX_LENGTH,
  PRECIO_MAXIMO,
} from './silla.constraints';

export class CrearSillaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(NOMBRE_MAX_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  nombre!: string;

  // maxDecimalPlaces: 2 porque el precio se cobra en pesos con centavos
  // (no tiene sentido, y Mercado Pago no acepta, más precisión que esa).
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(PRECIO_MAXIMO)
  precio!: number;

  @IsInt()
  @Min(1)
  @Max(120)
  duracionMin!: number;

  /** ID del dispositivo en Shelly Cloud (validar con GET /admin/shelly/dispositivos/:deviceId). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(12)
  @Matches(DEVICE_ID_SHELLY_REGEX, { message: DEVICE_ID_SHELLY_MENSAJE })
  deviceIdShelly!: string;
}
