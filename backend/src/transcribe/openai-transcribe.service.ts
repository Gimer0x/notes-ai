import { readFile } from 'fs/promises';
import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIError, toFile } from 'openai';
import { canonicalizeWav } from './canonicalize-wav';
import { wavDurationSeconds } from './split-wav';
import {
  addUsage,
  costFromUsageAndRates,
  formatTranscribeCostLine,
  loadOpenAiModelRates,
  usageFromTranscription,
  type TranscribeUsage,
} from './stt-cost';
import { meetingLanguage } from './meeting-language';
import type { MeetingLanguage, TranscriptResult, TranscribeService } from './transcribe.service';

const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

const STT_PROMPT_ECHOES = [
  'Transcribe all speech in this application playback from the beginning. Ignore trailing silence. The language may be English or Spanish.',
  'Transcribe the microphone speech from the beginning to the end. The language may be English or Spanish.',
  'Transcribe every spoken word from the start of this clip to the end. The audio may include English and Spanish, app playback, and a microphone.',
];

function sttPrompt(originalName: string): string {
  const name = originalName.toLowerCase();
  if (name.includes('system') || name.includes('sys')) {
    return STT_PROMPT_ECHOES[0];
  }
  if (name.includes('mic')) {
    return STT_PROMPT_ECHOES[1];
  }
  return STT_PROMPT_ECHOES[2];
}

/** gpt-4o-mini-transcribe often copies the `prompt` into `text`. Keep the spoken words only. */
export function stripSttPromptEcho(text: string): string {
  let out = text.trim();
  let changed = true;
  while (changed && out) {
    changed = false;
    for (const prompt of STT_PROMPT_ECHOES) {
      const escaped = prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const next = out.replace(new RegExp(`^${escaped}[\\s"'“”‘’.:;,-]*`, 'i'), '').trim();
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out;
}

@Injectable()
export class OpenAiTranscribeService implements TranscribeService {
  constructor(private readonly config: ConfigService) {}

  async transcribe(wavPaths: string[]): Promise<TranscriptResult> {
    const buffers = await Promise.all(wavPaths.map((path) => readFile(path)));
    return this.transcribeBuffers(buffers, 'audio.wav');
  }

  async transcribeBuffers(
    buffers: Buffer[],
    originalName: string,
  ): Promise<TranscriptResult> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('transcription_unconfigured');
    }

    const model =
      this.config.get<string>('OPENAI_TRANSCRIBE_MODEL')?.trim() ||
      DEFAULT_MODEL;

    const openai = new OpenAI({ apiKey, maxRetries: 1, timeout: 120_000 });
    const parts: string[] = [];
    let language: MeetingLanguage = 'en';
    let usage: TranscribeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      durationSeconds: 0,
    };

    try {
      for (const [index, buffer] of buffers.entries()) {
        const prepared = canonicalizeWav(buffer);
        const filename =
          prepared === buffer
            ? originalName || `audio-${index}.wav`
            : 'audio.wav';
        const duration = wavDurationSeconds(prepared) ?? 0;
        const prompt = sttPrompt(originalName);
        console.log(
          `stt start file=${filename} duration=${duration.toFixed(2)}s bytes=${prepared.length} model=${model}`,
        );
        const file = await toFile(prepared, filename, {
          type: filename.endsWith('.wav') ? 'audio/wav' : undefined,
        });
        const useVerbose = model.startsWith('whisper');
        const result = await openai.audio.transcriptions.create({
          file,
          model,
          // Whisper uses prompt as prior transcript context. gpt-4o-mini-transcribe
          // treats it as an instruction and often copies it into the notes.
          ...(useVerbose
            ? { prompt, response_format: 'verbose_json' as const }
            : {}),
        });

        const text = stripSttPromptEcho(result.text ?? '');
        parts.push(text);
        console.log(`stt done file=${filename} chars=${text.length}`);
        language = useVerbose
          ? this.fromApiLanguage(
              'language' in result ? String(result.language) : undefined,
            )
          : meetingLanguage(text);
        usage = addUsage(
          usage,
          usageFromTranscription(result, duration),
        );
      }
    } catch (error) {
      if (error instanceof APIError) {
        throw new BadGatewayException('transcription_unavailable');
      }
      throw error;
    }

    void this.logSttCost(model, usage);

    return {
      language,
      transcript: parts.filter(Boolean).join(' ').trim(),
    };
  }

  private async logSttCost(model: string, usage: TranscribeUsage): Promise<void> {
    try {
      const rates = await loadOpenAiModelRates(model);
      console.log(
        `[spike] ${formatTranscribeCostLine({
          model,
          cost: costFromUsageAndRates(usage, rates),
        })}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'openai_model_docs_failed';
      console.log(
        `[spike] ${formatTranscribeCostLine({
          model,
          cost: { usd: null, reason },
        })}`,
      );
    }
  }

  private fromApiLanguage(detected: string | undefined): MeetingLanguage {
    const normalized = (detected ?? '').toLowerCase();
    if (normalized.startsWith('es') || normalized.includes('spanish')) {
      return 'es';
    }
    return 'en';
  }
}
