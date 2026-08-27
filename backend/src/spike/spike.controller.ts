import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Express } from 'express';
import { readPublicAppConfig } from '../config/app-config';
import { OpenAiTranscribeService } from '../transcribe/openai-transcribe.service';
import { splitWavBySeconds } from '../transcribe/split-wav';
import { SpikeKeyGuard } from './spike-key.guard';

/** Spike-only ceiling. OpenAI is still 25 MB per part; we split at WAV_CHUNK_SECONDS. */
const SPIKE_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

@Controller('spike')
@UseGuards(SpikeKeyGuard)
export class SpikeController {
  constructor(
    private readonly transcribeService: OpenAiTranscribeService,
    private readonly config: ConfigService,
  ) {}

  @Post('transcribe')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(),
      limits: { fileSize: SPIKE_MAX_UPLOAD_BYTES },
    }),
  )
  async transcribe(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ text: string; language: 'en' | 'es' }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('audio file is required');
    }

    const chunkSeconds = readPublicAppConfig(this.config).wavChunkSeconds;
    const parts = splitWavBySeconds(file.buffer, chunkSeconds);
    console.log(
      `spike wav bytes=${file.buffer.length} parts=${parts.length} chunkSeconds=${chunkSeconds} name=${file.originalname} head=${file.buffer.subarray(0, 16).toString('hex')}`,
    );

    try {
      const result = await this.transcribeService.transcribeBuffers(
        parts,
        file.originalname,
      );
      console.log(`spike transcript chars=${result.transcript.length}`);
      return { text: result.transcript, language: result.language };
    } finally {
      if (file.buffer) {
        file.buffer.fill(0);
      }
      for (const part of parts) {
        part.fill(0);
      }
    }
  }
}
