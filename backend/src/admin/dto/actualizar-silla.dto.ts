import { IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class ActualizarSillaDto {
  @IsOptional()
  @IsString()
  nombre?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  precio?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  duracionMin?: number;

  /** Cambiar el dispositivo Shelly vinculado (revalida modelo). */
  @IsOptional()
  @IsString()
  deviceIdShelly?: string;
}

export class ActivarManualDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  duracionMin?: number;
}
