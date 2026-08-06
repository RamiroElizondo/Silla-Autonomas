import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Definir ADMIN_EMAIL y ADMIN_PASSWORD en .env');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.usuarioAdmin.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash },
  });
  console.log(`Usuario admin listo: ${email}`);

  // Silla de ejemplo (editar device_id_shelly con el ID real del Shelly Plus 1)
  const existente = await prisma.silla.findFirst();
  if (!existente) {
    await prisma.silla.create({
      data: {
        nombre: 'Silla 1',
        precio: 3000,
        duracionMin: 10,
        deviceIdShelly: 'CAMBIAR_DEVICE_ID',
      },
    });
    console.log('Silla de ejemplo creada');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
