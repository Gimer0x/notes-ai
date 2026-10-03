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
  const bullets = text
    .split('\n')
    .map((line) => line.replace(/^[\s\-*•\d.)]+/, '').trim())
    .filter((line) => line.length > 0);
  return bullets.slice(0, 8);
}
