import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  // El navegador ya no le pega directo al backend: todo pasa por el proxy
  // /api del frontend (server-to-server, sin CORS de por medio). Esto queda
  // permisivo solo como comodidad para pegarle al backend a mano (curl,
  // Postman, Swagger) durante el desarrollo.
  app.enableCors({ origin: true });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`Backend escuchando en puerto ${port}`);
}

bootstrap();
