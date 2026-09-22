import { contarReservasPendientesPorIp } from './reservas-pendientes.util';

describe('contarReservasPendientesPorIp', () => {
  it('suma sesiones PENDIENTE y turnos ESPERANDO_PAGO del mismo ip_hash', async () => {
    const prisma: any = {
      sesion: { count: jest.fn().mockResolvedValue(2) },
      turno: { count: jest.fn().mockResolvedValue(1) },
    };

    const total = await contarReservasPendientesPorIp(prisma, 'hash-x');

    expect(total).toBe(3);
    expect(prisma.sesion.count).toHaveBeenCalledWith({
      where: { ipHash: 'hash-x', estado: 'PENDIENTE' },
    });
    expect(prisma.turno.count).toHaveBeenCalledWith({
      where: { ipHash: 'hash-x', estado: 'ESPERANDO_PAGO' },
    });
  });

  it('IPs (hashes) distintos no se mezclan entre sí', async () => {
    const prisma: any = {
      sesion: {
        count: jest.fn((args) => Promise.resolve(args.where.ipHash === 'hash-a' ? 3 : 0)),
      },
      turno: { count: jest.fn().mockResolvedValue(0) },
    };

    expect(await contarReservasPendientesPorIp(prisma, 'hash-a')).toBe(3);
    expect(await contarReservasPendientesPorIp(prisma, 'hash-b')).toBe(0);
  });

  it('solo cuenta el estado pendiente, no canceladas ni expiradas', async () => {
    // La ventana se libera sola: una vez que expirarPagoPendiente/cancelarCheckout
    // cambia el estado de la sesión, esta consulta deja de contarla porque el
    // where filtra por estado explícitamente (no por "todas las de este hash").
    const prisma: any = {
      sesion: { count: jest.fn().mockResolvedValue(0) },
      turno: { count: jest.fn().mockResolvedValue(0) },
    };

    await contarReservasPendientesPorIp(prisma, 'hash-x');

    expect(prisma.sesion.count.mock.calls[0][0].where.estado).toBe('PENDIENTE');
    expect(prisma.turno.count.mock.calls[0][0].where.estado).toBe('ESPERANDO_PAGO');
  });
});
