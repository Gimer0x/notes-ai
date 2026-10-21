import type { MeetingSnippet } from './meeting-context';

const WINDOW_DAYS = 28;

const TODO_PROMPTS = new Set([
  'list the recent to-dos and next steps from my meetings.',
  'lista los pendientes y próximos pasos recientes de mis reuniones.',
]);

const TASK_HEADING =
  /\b(next steps?|proximos pasos|tareas?( asignadas)?|pendientes|seguimiento|follow-?ups?|action items?|acciones|to-?dos?)\b/;

const ACTION =
  /\b(next steps?|proximos pasos|pendientes?|follow-?ups?|action items?|to-?dos?|encarg\w*|buscara\w*|actualizara\w*|programara\w*|establecera\w*|desarrollara\w*|enviara\w*|agendara\w*|revisara\w*|confirmara\w*|entregara\w*|llamara\w*|contactara\w*|preparara\w*|escribira\w*|presentara\w*|compartira\w*|definira\w*|hay que|tiene que|tienen que|se necesita|necesita(?:n|mos)?|need to|needs to|should|schedule|scheduling|proxima reunion)\b/;

const LEAD_IN = /siguientes pasos|following steps|these steps/;

const NOT_ACTION =
  /\b(no follow-?ups?|no next steps?|sin seguimiento|no hay pendientes|nothing else|no to-?dos?)\b/;

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  febrero: 2,
  february: 2,
  feb: 2,
  marzo: 3,
  march: 3,
  mar: 3,
  abril: 4,
  april: 4,
  apr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  june: 6,
  jun: 6,
  julio: 7,
  july: 7,
  jul: 7,
  agosto: 8,
  august: 8,
  aug: 8,
  septiembre: 9,
  setiembre: 9,
  september: 9,
  sep: 9,
  sept: 9,
  octubre: 10,
  october: 10,
  oct: 10,
  noviembre: 11,
  november: 11,
  nov: 11,
  diciembre: 12,
  december: 12,
  dec: 12,
  enero: 1,
};

export type TodoItem = { text: string; due: string };

export function isTodoRequest(text: string): boolean {
  return TODO_PROMPTS.has(text.trim().toLowerCase());
}

export function extractTodoItems(summary: string, year: number): TodoItem[] {
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  let taskSection = false;
  for (const raw of summary.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('# ')) {
      taskSection = isTaskHeading(trimmed.slice(2));
      continue;
    }
    const text = trimmed.replace(/^[•*\-]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!text || isLeadIn(text) || isDismissed(text) || seen.has(text)) {
      continue;
    }
    if (!taskSection && !isActionLine(text)) {
      continue;
    }
    seen.add(text);
    items.push({ text, due: findDue(text, year) ?? '' });
  }
  return items;
}

export function buildTodoAnswer(meetings: MeetingSnippet[], now = new Date()): string {
  const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const lines = ['@@todos', `from ${start.toISOString()}`, `to ${now.toISOString()}`];
  for (const meeting of meetings) {
    const when = new Date(meeting.when);
    if (Number.isNaN(when.getTime()) || when < start || when > now) {
      continue;
    }
    const note = meeting.summary.trim() || meeting.transcript;
    const items = extractTodoItems(note, when.getUTCFullYear());
    if (items.length === 0) {
      continue;
    }
    lines.push('@@note', meeting.title.trim().replace(/\s+/g, ' ') || 'Untitled', meeting.when);
    for (const item of items) {
      lines.push('@@item', item.text.replace(/\s+/g, ' '), '@@due', item.due);
    }
  }
  return lines.join('\n');
}

function isTaskHeading(title: string): boolean {
  return TASK_HEADING.test(fold(title));
}

function isActionLine(text: string): boolean {
  return ACTION.test(fold(text));
}

function isLeadIn(text: string): boolean {
  return LEAD_IN.test(fold(text));
}

function isDismissed(text: string): boolean {
  return NOT_ACTION.test(fold(text));
}

function fold(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function findDue(text: string, fallbackYear: number): string | null {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return dayMonthYear(Number(iso[3]), Number(iso[2]), Number(iso[1]));
  }
  const numeric = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (numeric) {
    const year = Number(numeric[3]) < 100 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    return dayMonthYear(Number(numeric[1]), Number(numeric[2]), year);
  }
  const named = text.match(
    /\b(\d{1,2})(?:\s+de)?\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b(?:(?:\s+de)?\s+(20\d{2}))?/i,
  );
  if (!named) {
    return null;
  }
  const month = MONTHS[named[2].toLowerCase()];
  const year = named[3] ? Number(named[3]) : fallbackYear;
  return dayMonthYear(Number(named[1]), month, year);
}

function dayMonthYear(day: number, month: number, year: number): string | null {
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000) {
    return null;
  }
  return `${day}/${month}/${year}`;
}
