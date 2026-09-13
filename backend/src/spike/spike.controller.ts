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
import { splitWavBySeconds, splitWavBySilence, analyzeWavSilence } from '../transcribe/split-wav';
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
    const analysis = analyzeWavSilence(file.buffer);
    const silenceParts = splitWavBySilence(file.buffer);
    const parts: Buffer[] = [];
    console.log(
      `spike wav name=${file.originalname} bytes=${file.buffer.length} chunkSeconds=${chunkSeconds} head=${file.buffer.subarray(0, 16).toString('hex')}`,
    );
    console.log(`spike ${analysis.summary}`);
    console.log(`spike silenceParts=${silenceParts.length}`);

    try {
      const texts: string[] = [];
      let language: 'en' | 'es' = 'en';
      for (const [index, part] of silenceParts.entries()) {
        const chunks = splitWavBySeconds(part, chunkSeconds);
        parts.push(...chunks);
        const result = await this.transcribeService.transcribeBuffers(
          chunks,
          file.originalname,
        );
        if (result.transcript) {
          texts.push(result.transcript);
        }
        language = result.language;
        console.log(
          `spike part=${file.originalname}#${index} chars=${result.transcript.length} preview=${result.transcript.replace(/\s+/g, ' ').trim().slice(0, 80)}`,
        );
      }
      const transcript = texts.join('\n\n').trim();
      console.log(`spike transcript chars=${transcript.length}`);
      return { text: transcript, language };
    } finally {
      if (file.buffer) {
        file.buffer.fill(0);
      }
      for (const part of parts) {
        part.fill(0);
      }
      for (const part of silenceParts) {
        part.fill(0);
      }
    }
  }
}
