import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SillasService {
  constructor(private readonly prisma: PrismaService) {}

  async obtener(id: string) {
    const silla = await this.prisma.silla.findUnique({ where: { id } });
    if (!silla) throw new NotFoundException('Silla no encontrada');
    return silla;
  }

  /** Estado público para la landing y la pantalla TV. */
  async estadoPublico(id: string) {
    const silla = await this.obtener(id);

    let segundosRestantes: number | null = null;
    if (silla.estado === 'EN_USO' && silla.finSesionActual) {
      segundosRestantes = Math.max(
        0,
        Math.round((silla.finSesionActual.getTime() - Date.now()) / 1000),
      );
    }

    return {
      id: silla.id,
      nombre: silla.nombre,
      estado: silla.estado,
      precio: Number(silla.precio),
      duracionMin: silla.duracionMin,
      segundosRestantes,
    };
  }
}
