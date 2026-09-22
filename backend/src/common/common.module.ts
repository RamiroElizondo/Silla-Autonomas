import { Global, Module } from '@nestjs/common';
import { IpHashService } from './ip-hash.service';
import { TurnstileService } from './turnstile.service';

/**
 * Servicios transversales usados por más de un módulo de negocio (pagos y
 * cola). @Global() para no tener que importarlo explícitamente en cada
 * módulo que los necesita — mismo patrón que PrismaModule.
 */
@Global()
@Module({
  providers: [TurnstileService, IpHashService],
  exports: [TurnstileService, IpHashService],
})
export class CommonModule {}
