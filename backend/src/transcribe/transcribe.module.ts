import { Module } from '@nestjs/common';
import { OpenAiTranscribeService } from './openai-transcribe.service';

@Module({
  providers: [OpenAiTranscribeService],
  exports: [OpenAiTranscribeService],
})
export class TranscribeModule {}
