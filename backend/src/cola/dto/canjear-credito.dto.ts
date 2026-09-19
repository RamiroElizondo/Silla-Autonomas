import { IsString, Length } from 'class-validator';

export class CanjearCreditoDto {
  /** Código del vale, ej. "LUZ-4821". Se normaliza en CreditosService. */
  @IsString()
  @Length(4, 20)
  codigo!: string;
}
