import { Injectable } from '@nestjs/common';

export type MeetingLanguage = 'en' | 'es';

export abstract class SummaryService {
  abstract summarize(
    transcript: string,
    language: MeetingLanguage,
    durationSeconds?: number | null,
    typedNotes?: string | null,
  ): Promise<{ bullets: string[] }>;
}

@Injectable()
export class TestSummaryService extends SummaryService {
  summarize(
    transcript: string,
    _language?: MeetingLanguage,
    _durationSeconds?: number | null,
    typedNotes?: string | null,
  ): Promise<{ bullets: string[] }> {
    const source = [typedNotes ?? '', transcript].filter((part) => part.trim().length > 0).join('\n');
    const line = source
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    return Promise.resolve({ bullets: line ? [line.slice(0, 200)] : [] });
  }
}

/** Ceiling for main sections. A closing section counts only when the meeting needs one. */
export function summarySectionLimit(durationSeconds: number | null | undefined): number {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return 10;
  }
  const minutes = durationSeconds / 60;
  if (minutes < 10) {
    return 4;
  }
  if (minutes < 30) {
    return 8;
  }
  return 10;
}

const DEFAULT_SECTIONS = 8;

export function parseSummaryBullets(text: string, maxSections = DEFAULT_SECTIONS): string[] {
  const lines = text
    .split('\n')
    .map((line) => normalizeSummaryLine(line.replace(/\t/g, '  ')))
    .filter((line) => line.length > 0)
    .slice(0, 80);
  return arrangeSections(lines, Math.max(1, maxSections)).flat();
}

function arrangeSections(lines: string[], maxSections: number): string[][] {
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
  const kept =
    ordered.length <= maxSections
      ? ordered
      : (() => {
          const last = ordered[ordered.length - 1];
          if (last && isClosingSection(last[0] ?? '')) {
            return [...ordered.slice(0, maxSections - 1), last];
          }
          return ordered.slice(0, maxSections);
        })();
  return kept.map(shapeSection);
}

const MAX_BULLETS = 5;
const MAX_NUMBERED = 5;

/** Second level is bullets. Third level is a numbered list under the bullet above it. */
function shapeSection(lines: string[]): string[] {
  const heading = lines[0]?.startsWith('# ') ? lines[0] : null;
  const body = heading ? lines.slice(1) : lines;
  const bullets: { text: string; children: string[] }[] = [];
  for (const line of body) {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const text = line.trim().replace(/^(?:[•\-*]|\d+[.)])\s+/, '').trim();
    if (!text) {
      continue;
    }
    const nested = indent >= 2 && bullets.length > 0;
    if (nested) {
      const current = bullets[bullets.length - 1];
      if (current.children.length < MAX_NUMBERED) {
        current.children.push(text);
      }
      continue;
    }
    if (bullets.length < MAX_BULLETS) {
      bullets.push({ text, children: [] });
    }
  }
  const shapedBullets =
    bullets.length === 1 && bullets[0].children.length > 0
      ? [
          { text: bullets[0].text, children: [] as string[] },
          ...bullets[0].children.map((text) => ({ text, children: [] as string[] })),
        ]
      : bullets;
  const shaped: string[] = heading ? [heading] : [];
  for (const bullet of shapedBullets) {
    shaped.push(`• ${bullet.text}`);
    bullet.children.forEach((child, index) => {
      shaped.push(`  ${index + 1}. ${child}`);
    });
  }
  return shaped;
}

function isClosingSection(heading: string): boolean {
  const title = heading.replace(/^#\s+/, '').trim().toLowerCase();
  return (
    title === 'conclusions' ||
    title === 'conclusiones' ||
    title === 'next steps' ||
    title === 'próximos pasos' ||
    title === 'proximos pasos' ||
    title === 'summary' ||
    title === 'resumen'
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
