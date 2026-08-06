import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  app.enableCors({
    origin: process.env.FRONTEND_URL ?? true,
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`Backend escuchando en puerto ${port}`);
}

bootstrap();
