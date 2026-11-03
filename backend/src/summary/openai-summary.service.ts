import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIError } from 'openai';
import { parseSummaryBullets, summarySectionLimit, SummaryService, type MeetingLanguage } from './summary.service';

const DEFAULT_MODEL = 'gpt-4o-mini';

@Injectable()
export class OpenAiSummaryService extends SummaryService {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async summarize(
    transcript: string,
    language: MeetingLanguage,
    durationSeconds?: number | null,
    typedNotes?: string | null,
  ): Promise<{ bullets: string[] }> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('summary_unconfigured');
    }
    const model = this.config.get<string>('OPENAI_SUMMARY_MODEL')?.trim() || DEFAULT_MODEL;
    const spoken = language === 'es' ? 'Spanish' : 'English';
    const closing = language === 'es' ? 'Conclusiones' : 'Conclusions';
    const steps = language === 'es' ? 'Próximos pasos' : 'Next steps';
    const recap = language === 'es' ? 'Resumen' : 'Summary';
    const limit = summarySectionLimit(durationSeconds);
    const minutes =
      durationSeconds != null && Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? Math.max(1, Math.round(durationSeconds / 60))
        : null;
    const depth =
      limit <= 3
        ? 'Put one or two ideas under each heading.'
        : 'When several ideas belong to the same topic, keep them as bullets and indented sub-points under that one heading.';
    const range =
      limit >= 10
        ? 'Use 8 to 10 sections when the meeting has that much substance, and never more than 10.'
        : `Use at most ${limit} sections.`;
    const notes = typedNotes?.trim() ?? '';
    const openai = new OpenAI({ apiKey, maxRetries: 1, timeout: 120_000 });
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You write a structured meeting summary in ${spoken}. Use only this layout:
- Each section starts with a heading line: "# Section title"
- Under a heading, each point is a bullet line that starts with "• "
- Indent a sub-point with two spaces, still starting with "• "
- When one point has scenarios or steps, list them underneath as indented lines "1. ", "2. ", "3. "
No preamble, no dash bullets, and no text before the first heading.
${range} That number is a ceiling, not a quota. Use fewer sections when the meeting is thin. Do not invent sections to fill the cap. Merge related ideas under one heading instead of adding another section.
${depth}
Add a final section only when the meeting has something worth remarking that is not already covered. Use "${steps}" when there are follow-up actions. Use "${closing}" when there are decisions or takeaways to remark. Use "${recap}" when a short recap of the important points is useful. If the meeting is thin, or those points already sit in the sections above, do not add this section. When you add one, it is the last section, it counts toward the ceiling, and you add only one of those three.
Keep every URL, email address, person, company, product name, date, amount, and decision from the user's typed notes exactly. Place each fact in the section it belongs to. Do not add a heading only for those notes. Do not drop one of these facts to make the summary shorter. A link stays the full URL.`,
          },
          {
            role: 'user',
            content: summaryInput(transcript, notes, minutes),
          },
        ],
      });
      const text = completion.choices[0]?.message?.content ?? '';
      const bullets = parseSummaryBullets(text, limit);
      if (bullets.length === 0) {
        throw new BadGatewayException('empty_summary');
      }
      return { bullets };
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      if (error instanceof APIError) {
        throw new BadGatewayException('summary_unavailable');
      }
      throw error;
    }
  }
}

function summaryInput(transcript: string, notes: string, minutes: number | null): string {
  const length = minutes == null ? 'Meeting length: unknown.' : `Meeting length: ${minutes} minutes.`;
  const spoken = transcript.trim().slice(0, 100_000);
  const written = notes.trim().slice(0, 20_000);
  const noteBlock = written
    ? `Notes the user typed. These are required facts, not optional color:\n${written}`
    : 'Notes the user typed: none.';
  return `${length}\n\n${noteBlock}\n\nSpoken meeting:\n${spoken || '(no speech transcribed)'}`;
}
