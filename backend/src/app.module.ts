import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { PagosModule } from './pagos/pagos.module';
import { PrismaModule } from './prisma/prisma.module';
import { SesionesModule } from './sesiones/sesiones.module';
import { ShellyModule } from './shelly/shelly.module';
import { SillasModule } from './sillas/sillas.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Rate limiting global: 30 requests por 10 segundos por IP
    ThrottlerModule.forRoot([{ ttl: 10_000, limit: 30 }]),
    PrismaModule,
    ShellyModule,
    SesionesModule,
    SillasModule,
    PagosModule,
    AdminModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
