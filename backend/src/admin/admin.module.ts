import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SesionesModule } from '../sesiones/sesiones.module';
import { ShellyModule } from '../shelly/shelly.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    SesionesModule,
    ShellyModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '8h') },
      }),
    }),
  ],
  controllers: [AuthController, AdminController],
  providers: [AuthService, AdminService, JwtAuthGuard],
})
export class AdminModule {}
