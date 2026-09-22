import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { ColaModule } from './cola/cola.module';
import { CommonModule } from './common/common.module';
import { IpThrottlerGuard } from './common/ip-throttler.guard';
import { LIMITE_GLOBAL } from './common/throttle.config';
import { PagosModule } from './pagos/pagos.module';
import { PrismaModule } from './prisma/prisma.module';
import { SesionesModule } from './sesiones/sesiones.module';
import { ShellyModule } from './shelly/shelly.module';
import { SillasModule } from './sillas/sillas.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Rate limiting global por IP real (ver IpThrottlerGuard y
    // common/throttle.config.ts — Hallazgo ALTO 1 de la auditoría).
    ThrottlerModule.forRoot([
      { ttl: LIMITE_GLOBAL.ttl, limit: LIMITE_GLOBAL.limit },
    ]),
    PrismaModule,
    CommonModule,
    ShellyModule,
    SesionesModule,
    SillasModule,
    PagosModule,
    ColaModule,
    AdminModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: IpThrottlerGuard }],
})
export class AppModule {}
