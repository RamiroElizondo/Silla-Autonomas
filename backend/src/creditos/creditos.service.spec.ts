import { NotFoundException } from '@nestjs/common';
import { CreditosService } from './creditos.service';

const MENSAJE_ESPERADO = 'Código inválido o ya utilizado';

describe('CreditosService.tomar — respuesta uniforme (Hallazgo ALTO 3)', () => {
  it('código inexistente: NotFoundException con el mensaje genérico', async () => {
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const servicio = new CreditosService(prisma);

    await expect(servicio.tomar('LUZ-0000')).rejects.toThrow(NotFoundException);
    await expect(servicio.tomar('LUZ-0000')).rejects.toThrow(MENSAJE_ESPERADO);
  });

  it('código ya usado: mismo NotFoundException y mismo mensaje', async () => {
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          estado: 'CANJEADO',
          venceEn: new Date(Date.now() + 60_000),
        }),
      },
    };
    const servicio = new CreditosService(prisma);

    await expect(servicio.tomar('LUZ-1111')).rejects.toThrow(NotFoundException);
    await expect(servicio.tomar('LUZ-1111')).rejects.toThrow(MENSAJE_ESPERADO);
  });

  it('código vencido: mismo NotFoundException y mismo mensaje, y lo marca VENCIDO internamente', async () => {
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'c2',
          estado: 'DISPONIBLE',
          venceEn: new Date(Date.now() - 60_000),
        }),
      },
    };

    const servicio = new CreditosService(prisma);

    await expect(servicio.tomar('LUZ-2222')).rejects.toThrow(NotFoundException);
    await expect(servicio.tomar('LUZ-2222')).rejects.toThrow(MENSAJE_ESPERADO);

    // Se le da tiempo al fire-and-forget interno (registrarIntentoFallido)
    // de correr antes de verificar que marcó el vencimiento.
    await new Promise((r) => setTimeout(r, 10));
    expect(prisma.credito.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'c2', estado: 'DISPONIBLE' }),
        data: expect.objectContaining({ estado: 'VENCIDO' }),
      }),
    );
  });

  it('código válido: lo marca CANJEADO y devuelve el crédito', async () => {
    const creditoCanjeado = { id: 'c3', codigo: 'LUZ-3333', estado: 'CANJEADO' };
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(creditoCanjeado),
      },
    };
    const servicio = new CreditosService(prisma);

    const resultado = await servicio.tomar('LUZ-3333');

    expect(resultado).toBe(creditoCanjeado);
    expect(prisma.credito.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ codigo: 'LUZ-3333', estado: 'DISPONIBLE' }),
        data: expect.objectContaining({ estado: 'CANJEADO' }),
      }),
    );
  });

  it('dos canjes concurrentes del mismo código: solo uno tiene éxito', async () => {
    // Simula la semántica real de un UPDATE condicional en la base: el
    // primero que llega matchea `estado: DISPONIBLE` y lo cambia; el
    // segundo ya no matchea nada.
    let disponible = true;
    const prisma: any = {
      credito: {
        updateMany: jest.fn().mockImplementation(async () => {
          if (disponible) {
            disponible = false;
            return { count: 1 };
          }
          return { count: 0 };
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'c4', estado: 'CANJEADO' }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'c4',
          estado: 'CANJEADO',
          venceEn: new Date(Date.now() + 60_000),
        }),
      },
    };
    const servicio = new CreditosService(prisma);

    const resultados = await Promise.allSettled([
      servicio.tomar('LUZ-4444'),
      servicio.tomar('LUZ-4444'),
    ]);

    const exitos = resultados.filter((r) => r.status === 'fulfilled');
    const fallos = resultados.filter((r) => r.status === 'rejected');
    expect(exitos).toHaveLength(1);
    expect(fallos).toHaveLength(1);
  });
});
