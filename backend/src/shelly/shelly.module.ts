import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { ShellyService } from './shelly.service';

@Module({
  providers: [ShellyService, HeartbeatService],
  exports: [ShellyService, HeartbeatService],
})
export class ShellyModule {}
