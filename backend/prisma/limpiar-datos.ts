/**
 * Limpia los datos de prueba: borra sesiones, pagos, turnos y créditos.
 * CONSERVA sillas y usuarios_admin (y deja las sillas en estado LIBRE).
 *
 * Por defecto solo muestra qué haría (dry-run). Para ejecutar de verdad:
 *   npx ts-node prisma/limpiar-datos.ts --confirmar
 *
 * Detené el backend antes de correrlo (tiene timers en memoria).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const confirmar = process.argv.includes('--confirmar');

  const conteos = {
    sillas: await prisma.silla.count(),
    usuarios_admin: await prisma.usuarioAdmin.count(),
    sesiones: await prisma.sesion.count(),
    pagos: await prisma.pago.count(),
    turnos: await prisma.turno.count(),
    creditos: await prisma.credito.count(),
  };
  console.log('Estado actual:', conteos);

  if (!confirmar) {
    console.log('\nDry-run: no se borró nada. Agregá --confirmar para ejecutar.');
    return;
  }

  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "pagos", "creditos", "turnos", "sesiones" RESTART IDENTITY CASCADE',
    ),
    prisma.silla.updateMany({
      data: { estado: 'LIBRE', finSesionActual: null },
    }),
  ]);

  console.log('\nListo. Sillas y admin conservados; el resto quedó vacío.');
  console.log('Ahora:', {
    sillas: await prisma.silla.count(),
    usuarios_admin: await prisma.usuarioAdmin.count(),
    sesiones: await prisma.sesion.count(),
    pagos: await prisma.pago.count(),
    turnos: await prisma.turno.count(),
    creditos: await prisma.credito.count(),
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
