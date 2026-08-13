import { IsUUID } from 'class-validator';

export class CancelarPagoDto {
  @IsUUID()
  sesionId!: string;
}
