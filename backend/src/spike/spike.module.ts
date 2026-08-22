import { Module } from '@nestjs/common';
import { TranscribeModule } from '../transcribe/transcribe.module';
import { SpikeController } from './spike.controller';
import { SpikeKeyGuard } from './spike-key.guard';

@Module({
  imports: [TranscribeModule],
  controllers: [SpikeController],
  providers: [SpikeKeyGuard],
})
export class SpikeModule {}
