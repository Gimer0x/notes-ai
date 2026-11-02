import { AsyncLocalStorage } from 'async_hooks';
import {
  BadGatewayException,
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
const spikeLogs = new AsyncLocalStorage<string[]>();

const writeConsole = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
  spikeLogs.getStore()?.push(line);
  writeConsole(...args);
};

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
  ): Promise<{ text: string; language: 'en' | 'es'; logs: string[] }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('audio_required');
    }

    const logs: string[] = [];
    const chunkSeconds = readPublicAppConfig(this.config).wavChunkSeconds;
    const analysis = analyzeWavSilence(file.buffer);
    const silenceParts = splitWavBySilence(file.buffer);
    const parts: Buffer[] = [];
    try {
      return await spikeLogs.run(logs, async () => {
      console.log(
        `spike wav name=${file.originalname} bytes=${file.buffer.length} chunkSeconds=${chunkSeconds} head=${file.buffer.subarray(0, 16).toString('hex')}`,
      );
      console.log(`spike ${analysis.summary}`);
      console.log(`spike silenceParts=${silenceParts.length}`);

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
        console.log(`spike part=${file.originalname}#${index} chars=${result.transcript.length}`);
      }
      const transcript = texts.join('\n\n').trim();
      console.log(`spike transcript chars=${transcript.length}`);
      return { text: transcript, language, logs };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'transcribe_failed';
      throw new BadGatewayException({ message, logs });
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
