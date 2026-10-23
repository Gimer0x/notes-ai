import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { SummaryModule } from '../summary/summary.module';
import { TranscribeModule } from '../transcribe/transcribe.module';
import { SlicesController } from './slices.controller';
import { SlicesService } from './slices.service';

@Module({
  imports: [AuthModule, BillingModule, SummaryModule, TranscribeModule],
  controllers: [SlicesController],
  providers: [SlicesService],
})
export class SlicesModule {}
