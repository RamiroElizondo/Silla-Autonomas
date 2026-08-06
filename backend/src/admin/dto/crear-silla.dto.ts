import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CrearSillaDto {
  @IsString()
  @IsNotEmpty()
  nombre!: string;

  @IsNumber()
  @Min(1)
  precio!: number;

  @IsInt()
  @Min(1)
  @Max(120)
  duracionMin!: number;

  /** ID del dispositivo en Shelly Cloud (elegir de GET /admin/shelly/dispositivos). */
  @IsString()
  @IsNotEmpty()
  deviceIdShelly!: string;
}
