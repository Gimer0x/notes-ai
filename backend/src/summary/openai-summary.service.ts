import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIError } from 'openai';
import { parseSummaryBullets, SummaryService, type MeetingLanguage } from './summary.service';

const DEFAULT_MODEL = 'gpt-4o-mini';

@Injectable()
export class OpenAiSummaryService extends SummaryService {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async summarize(
    transcript: string,
    language: MeetingLanguage,
  ): Promise<{ bullets: string[] }> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI_API_KEY is not set');
    }
    const model = this.config.get<string>('OPENAI_SUMMARY_MODEL')?.trim() || DEFAULT_MODEL;
    const spoken = language === 'es' ? 'Spanish' : 'English';
    const openai = new OpenAI({ apiKey });
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You write meeting notes. Reply with 3 to 6 short bullet lines and nothing else. Each line is one decision, fact, or next step. No title and no preamble. Write in ${spoken}.`,
          },
          {
            role: 'user',
            content: transcript.slice(0, 12000),
          },
        ],
      });
      const text = completion.choices[0]?.message?.content ?? '';
      const bullets = parseSummaryBullets(text);
      if (bullets.length === 0) {
        throw new BadGatewayException('empty_summary');
      }
      return { bullets };
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      if (error instanceof APIError) {
        throw new BadGatewayException(error.message);
      }
      throw error;
    }
  }
}
