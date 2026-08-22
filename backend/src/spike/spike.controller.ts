import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Express } from 'express';
import { OpenAiTranscribeService } from '../transcribe/openai-transcribe.service';
import { SpikeKeyGuard } from './spike-key.guard';

@Controller('spike')
@UseGuards(SpikeKeyGuard)
export class SpikeController {
  constructor(private readonly transcribeService: OpenAiTranscribeService) {}

  @Post('transcribe')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async transcribe(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ text: string; language: 'en' | 'es' }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('audio file is required');
    }

    console.log(
      `spike wav bytes=${file.buffer.length} name=${file.originalname} head=${file.buffer.subarray(0, 16).toString('hex')}`,
    );

    try {
      const result = await this.transcribeService.transcribeBuffers(
        [file.buffer],
        file.originalname,
      );
      console.log(`spike transcript chars=${result.transcript.length}`);
      return { text: result.transcript, language: result.language };
    } finally {
      if (file.buffer) {
        file.buffer.fill(0);
      }
    }
  }
}
