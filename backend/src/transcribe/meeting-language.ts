import type { MeetingLanguage } from './transcribe.service';

const SPANISH = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'que', 'en', 'un', 'una', 'es', 'por', 'con', 'para',
  'como', 'está', 'están', 'este', 'esta', 'esto', 'pero', 'más', 'al', 'su', 'se', 'lo', 'le',
  'nos', 'hay', 'porque', 'también', 'ya', 'muy', 'sí', 'hola', 'gracias', 'bueno', 'entonces',
  'vamos', 'tiene', 'tenemos', 'qué', 'cómo', 'dónde', 'cuando', 'son', 'fue', 'ser',
  'sobre', 'entre', 'desde', 'hasta', 'todo', 'todos', 'ese', 'esa', 'aquí', 'hoy',
]);

const ENGLISH = new Set([
  'the', 'and', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'that', 'with', 'this', 'are', 'was',
  'be', 'you', 'we', 'have', 'not', 'from', 'they', 'but', 'or', 'at', 'as', 'by', 'an', 'if',
  'so', 'just', 'meeting', 'okay', 'ok', 'will', 'can', 'our', 'your', 'what', 'about', 'there',
]);

export type LanguageSample = {
  text: string;
  seconds?: number;
};

/** Spanish only when it outweighs English. Any other language stays English. */
export function meetingLanguage(text: string): MeetingLanguage {
  return mainMeetingLanguage([{ text }]);
}

export function mainMeetingLanguage(parts: LanguageSample[]): MeetingLanguage {
  let spanish = 0;
  let english = 0;
  for (const part of parts) {
    const weight = part.seconds != null && part.seconds > 0 ? part.seconds : 1;
    const score = scoreText(part.text);
    spanish += score.spanish * weight;
    english += score.english * weight;
  }
  return spanish > english ? 'es' : 'en';
}

function scoreText(text: string): { spanish: number; english: number } {
  const tokens = text.toLowerCase().match(/[a-záéíóúñü]+/gi) ?? [];
  let spanish = (text.match(/[áéíóúñ¿¡]/gi) ?? []).length * 2;
  let english = 0;
  for (const token of tokens) {
    if (token.length < 2) {
      continue;
    }
    if (SPANISH.has(token)) {
      spanish += 1;
    }
    if (ENGLISH.has(token)) {
      english += 1;
    }
  }
  return { spanish, english };
}
