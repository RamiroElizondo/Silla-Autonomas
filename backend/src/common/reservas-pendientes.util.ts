import type { PrismaService } from '../prisma/prisma.service';

/**
 * Cuenta cuántas reservas pendientes de pago tiene una misma IP (hasheada)
 * en este momento, sumando sesiones directas y turnos de cola (Hallazgo ALTO
 * 2): un mismo cliente/IP no debería poder acumular reservas sin límite en
 * ninguno de los dos flujos.
 */
export async function contarReservasPendientesPorIp(
  prisma: PrismaService,
  ipHash: string,
): Promise<number> {
  const [sesionesPendientes, turnosEsperandoPago] = await Promise.all([
    prisma.sesion.count({ where: { ipHash, estado: 'PENDIENTE' } }),
    prisma.turno.count({ where: { ipHash, estado: 'ESPERANDO_PAGO' } }),
  ]);
  return sesionesPendientes + turnosEsperandoPago;
}
