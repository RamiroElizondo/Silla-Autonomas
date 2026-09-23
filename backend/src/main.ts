import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import {
  resolverCorsOrigins,
  verificarEntornoDeArranque,
} from './common/verificar-entorno';

async function bootstrap() {
  verificarEntornoDeArranque();

  const app = await NestFactory.create(AppModule);

  // Este backend es una API JSON pura: nunca sirve HTML, así que la CSP
  // (pensada para documentos) va en el frontend (next.config.ts). Acá alcanza
  // con las cabeceras que sí aplican a una API: noSniff, frameguard,
  // ocultar X-Powered-By, HSTS, etc. `crossOriginResourcePolicy` en
  // 'cross-origin' porque el único consumidor real es el proxy same-origin
  // del frontend, pero en desarrollo también le pegan curl/Postman/Swagger
  // directo (ver el comentario de enableCors más abajo) — no tiene sentido
  // bloquear por origen algo que ya no depende del navegador.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  // El navegador ya no le pega directo al backend: todo pasa por el proxy
  // /api del frontend (server-to-server, sin CORS de por medio). CORS acá es
  // sobre todo defensa en profundidad / comodidad de desarrollo — ver
  // `resolverCorsOrigins` para la lógica completa (CORS_ORIGINS configurable,
  // permisivo en desarrollo, cerrado por default en producción).
  app.enableCors({ origin: resolverCorsOrigins() });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`Backend escuchando en puerto ${port}`);
}

bootstrap();
