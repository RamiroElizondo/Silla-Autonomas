import { Injectable, NotFoundException } from '@nestjs/common';
import { Silla } from '@prisma/client';
import { CACHE_TTL_ESTADO_MS } from '../common/cache.config';
import { TtlCache } from '../common/ttl-cache';
import { PrismaService } from '../prisma/prisma.service';
import { HeartbeatService } from '../shelly/heartbeat.service';

@Injectable()
export class SillasService {
  /**
   * Cache de la fila cruda de `silla` (Bloque C): la landing, la pantalla TV
   * y (indirectamente) la cola pueden pedir el estado de la misma silla
   * varias veces por segundo. Se cachea la fila tal cual sale de la base,
   * NUNCA la respuesta final: `segundosRestantes` se calcula en cada llamada
   * a `estadoPublico`, incluso en un hit de cache, porque depende de
   * `Date.now()` y cachearlo directamente lo dejaría pegado al valor del
   * momento en que se cargó la fila.
   */
  private readonly cache = new TtlCache<Silla | null>(CACHE_TTL_ESTADO_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  async obtener(id: string): Promise<Silla> {
    const silla = await this.cache.obtenerOCargar(id, () =>
      this.prisma.silla.findUnique({ where: { id } }),
    );
    if (!silla) throw new NotFoundException('Silla no encontrada');
    return silla;
  }

  /**
   * Fuerza a que el próximo `obtener`/`estadoPublico` de esta silla vuelva a
   * pegarle a la base. Se llama después de cualquier escritura que cambie
   * `estado` o `finSesionActual` de esta silla, sea desde este mismo
   * servicio o desde SesionesService/ColaService (ver el informe del Bloque
   * C para el detalle de qué sitios quedaron cableados).
   */
  invalidarCache(id: string): void {
    this.cache.invalidar(id);
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
      // El relé no contesta: casi siempre es corte de luz en el local. La
      // landing esconde el botón de pagar — no cobramos lo que no podemos
      // entregar.
      sinEnergia: this.heartbeat.estaOffline(silla.id),
    };
  }
}
