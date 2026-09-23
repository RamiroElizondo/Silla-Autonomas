import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

/**
 * `ParseIntPipe` (+ `DefaultValuePipe`) ya garantiza que el valor de un
 * query param sea un entero, pero no que esté en un rango razonable: un
 * `take=-5` o `skip=-1` pasa esa capa sin problema y después revienta contra
 * Prisma (500, porque `skip` negativo no es válido) o, peor, hace que Prisma
 * tome registros de la punta opuesta de la lista (`take` negativo).
 *
 * Este pipe se encadena DESPUÉS de `ParseIntPipe`/`DefaultValuePipe` en el
 * mismo `@Query(...)` (mismo patrón que ya usa este controller) para cortar
 * en la capa HTTP con un 400 claro, en vez de dejar que el error salga
 * mal formado desde la capa de datos.
 */
@Injectable()
export class ParseIntMinPipe implements PipeTransform<number, number> {
  constructor(private readonly min: number) {}

  transform(value: number, metadata: ArgumentMetadata): number {
    if (!Number.isInteger(value) || value < this.min) {
      throw new BadRequestException(
        `El parámetro "${metadata.data}" debe ser un entero mayor o igual a ${this.min}`,
      );
    }
    return value;
  }
}
