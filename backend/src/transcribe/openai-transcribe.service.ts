import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIError, toFile } from 'openai';
import { canonicalizeWav } from './canonicalize-wav';
import type { MeetingLanguage, TranscriptResult, TranscribeService } from './transcribe.service';

const DEFAULT_MODEL = 'gpt-transcribe';

@Injectable()
export class OpenAiTranscribeService implements TranscribeService {
  constructor(private readonly config: ConfigService) {}

  async transcribe(
    buffers: Buffer[],
    originalName: string,
  ): Promise<TranscriptResult> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI_API_KEY is not set');
    }

    const model =
      this.config.get<string>('OPENAI_TRANSCRIBE_MODEL')?.trim() ||
      DEFAULT_MODEL;

    const openai = new OpenAI({ apiKey });
    const parts: string[] = [];
    let language: MeetingLanguage = 'en';

    try {
      for (const [index, buffer] of buffers.entries()) {
        const prepared = canonicalizeWav(buffer);
        const filename =
          prepared === buffer
            ? originalName || `audio-${index}.wav`
            : 'audio.wav';
        const file = await toFile(prepared, filename, {
          type: filename.endsWith('.wav') ? 'audio/wav' : undefined,
        });
        const useVerbose = model.startsWith('whisper');
        const result = await openai.audio.transcriptions.create({
          file,
          model,
          ...(useVerbose ? { response_format: 'verbose_json' as const } : {}),
        });

        const text = result.text.trim();
        parts.push(text);
        language = useVerbose
          ? this.fromApiLanguage(
              'language' in result ? String(result.language) : undefined,
            )
          : this.fromTranscript(text);
      }
    } catch (error) {
      if (error instanceof APIError) {
        throw new BadGatewayException(error.message);
      }
      throw error;
    }

    return {
      language,
      transcript: parts.filter(Boolean).join(' ').trim(),
    };
  }

  private fromApiLanguage(detected: string | undefined): MeetingLanguage {
    const normalized = (detected ?? '').toLowerCase();
    if (normalized.startsWith('es') || normalized.includes('spanish')) {
      return 'es';
    }
    return 'en';
  }

  private fromTranscript(text: string): MeetingLanguage {
    const tokens = text.toLowerCase().match(/[a-záéíóúñü]+/gi) ?? [];
    const spanishMarkers = new Set([
      'el',
      'la',
      'los',
      'las',
      'de',
      'que',
      'y',
      'en',
      'un',
      'una',
      'es',
      'por',
      'con',
      'para',
      'como',
      'está',
      'este',
      'esta',
      'pero',
      'más',
    ]);
    const englishMarkers = new Set([
      'the',
      'and',
      'of',
      'to',
      'a',
      'in',
      'is',
      'it',
      'for',
      'on',
      'that',
      'with',
      'this',
      'are',
      'was',
      'be',
    ]);
    let spanish = (text.match(/[áéíóúñ¿¡]/g) ?? []).length;
    let english = 0;
    for (const token of tokens) {
      if (spanishMarkers.has(token)) spanish += 1;
      if (englishMarkers.has(token)) english += 1;
    }
    return spanish > english ? 'es' : 'en';
  }
}
