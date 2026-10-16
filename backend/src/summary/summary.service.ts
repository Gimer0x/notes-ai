import { Injectable } from '@nestjs/common';

export type MeetingLanguage = 'en' | 'es';

export abstract class SummaryService {
  abstract summarize(
    transcript: string,
    language: MeetingLanguage,
  ): Promise<{ bullets: string[] }>;
}

@Injectable()
export class TestSummaryService extends SummaryService {
  summarize(transcript: string): Promise<{ bullets: string[] }> {
    const line = transcript
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    return Promise.resolve({ bullets: line ? [line.slice(0, 200)] : [] });
  }
}

export function parseSummaryBullets(text: string): string[] {
  return text
    .split('\n')
    .map((line) => normalizeSummaryLine(line.replace(/\t/g, '  ')))
    .filter((line) => line.length > 0)
    .slice(0, 60);
}

function normalizeSummaryLine(line: string): string {
  const indent = line.match(/^ */)?.[0].length ?? 0;
  const pad = '  '.repeat(Math.min(3, Math.floor(indent / 2)));
  const text = line.trim();
  if (!text) {
    return '';
  }
  if (/^#+\s+/.test(text)) {
    return `# ${text.replace(/^#+\s+/, '')}`;
  }
  const numbered = text.match(/^(\d+)[.)]\s+(.*)$/);
  if (numbered) {
    return `${pad}${numbered[1]}. ${numbered[2].trim()}`;
  }
  const bullet = text.match(/^[•\-*]\s+(.*)$/);
  if (bullet) {
    return `${pad}• ${bullet[1].trim()}`;
  }
  return `${pad}• ${text}`;
}
