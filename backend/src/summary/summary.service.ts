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

const MAX_SECTIONS = 8;

export function parseSummaryBullets(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => normalizeSummaryLine(line.replace(/\t/g, '  ')))
    .filter((line) => line.length > 0)
    .slice(0, 60);
  return arrangeSections(lines).flat();
}

function arrangeSections(lines: string[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# ') && current.length > 0) {
      sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current);
  }
  const closingAt = sections.findIndex((section) => isClosingSection(section[0] ?? ''));
  let ordered = sections;
  if (closingAt >= 0 && closingAt < sections.length - 1) {
    const closing = sections[closingAt];
    ordered = [
      ...sections.slice(0, closingAt),
      ...sections.slice(closingAt + 1),
      closing,
    ];
  }
  if (ordered.length <= MAX_SECTIONS) {
    return ordered;
  }
  const last = ordered[ordered.length - 1];
  if (last && isClosingSection(last[0] ?? '')) {
    return [...ordered.slice(0, MAX_SECTIONS - 1), last];
  }
  return ordered.slice(0, MAX_SECTIONS);
}

function isClosingSection(heading: string): boolean {
  const title = heading.replace(/^#\s+/, '').trim().toLowerCase();
  return (
    title === 'conclusions' ||
    title === 'conclusiones' ||
    title === 'next steps' ||
    title === 'próximos pasos' ||
    title === 'proximos pasos'
  );
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
