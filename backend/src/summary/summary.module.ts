import { Module } from '@nestjs/common';
import { OpenAiSummaryService } from './openai-summary.service';
import { SummaryService, TestSummaryService } from './summary.service';

@Module({
  providers: [
    {
      provide: SummaryService,
      useClass: process.env.NODE_ENV === 'test' ? TestSummaryService : OpenAiSummaryService,
    },
  ],
  exports: [SummaryService],
})
export class SummaryModule {}
