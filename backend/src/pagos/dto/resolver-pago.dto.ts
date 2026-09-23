import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const ACCIONES_RESOLUCION = ['emitir_vale', 'marcar_reembolsado', 'ignorar'] as const;
export type AccionResolucion = (typeof ACCIONES_RESOLUCION)[number];

export class ResolverPagoDto {
  @IsIn(ACCIONES_RESOLUCION)
  accion: AccionResolucion;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  nota?: string;

  /**
   * Duración del vale en minutos. Obligatoria solo para 'emitir_vale' cuando
   * el pago no tiene sesión ni turno asociado (external_reference
   * desconocido) y por lo tanto no hay una duración de referencia — en
   * cualquier otro caso se usa la duración de la sesión/turno original y
   * este campo, si se manda, se ignora.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  duracionMinVale?: number;
}
