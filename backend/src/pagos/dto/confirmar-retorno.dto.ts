import { IsString, Matches } from 'class-validator';

export class ConfirmarRetornoDto {
  @IsString()
  @Matches(/^\d+$/, { message: 'paymentId debe ser numérico' })
  paymentId!: string;
}
