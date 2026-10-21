import type { MeetingSnippet } from './meeting-context';
import { buildMeetingContext } from './meeting-context';
import { extractPdfText } from './pdf-text';

export type AskTurn = { role: 'user' | 'assistant'; text: string };

export type AskFile = { name: string; mime: string; dataBase64: string };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatPart[];
};

type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);

export function buildChatMessages(
  meetings: MeetingSnippet[],
  turns: AskTurn[],
  files: AskFile[],
): ChatMessage[] {
  const context = buildMeetingContext(meetings);
  const system = `You answer questions about the user's past meetings. Use only the meeting notes below and any files attached to the latest question. If the notes do not contain the answer, say so. Reply in the language of the question. When you use a meeting, name it. For a request about todos or next steps, list the follow-ups from the summaries, newest first, one item per line. Do not start a line with a hyphen, dash, asterisk, or number. Do not use markdown.
Meeting notes:
${context || '(none yet)'}`;
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  turns.forEach((turn, index) => {
    const isLastUser = turn.role === 'user' && index === turns.length - 1;
    if (isLastUser && files.length > 0) {
      messages.push({ role: 'user', content: userParts(turn.text, files) });
      return;
    }
    messages.push({ role: turn.role, content: turn.text });
  });
  return messages;
}

function userParts(text: string, files: AskFile[]): ChatPart[] {
  const notes: string[] = [];
  const images: ChatPart[] = [];
  for (const file of files) {
    const mime = file.mime.toLowerCase();
    const buffer = Buffer.from(file.dataBase64, 'base64');
    if (IMAGE_TYPES.has(mime)) {
      images.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${file.dataBase64}` },
      });
      continue;
    }
    const extracted = mime === 'application/pdf' ? extractPdfText(buffer) : TEXT_TYPES.has(mime) ? buffer.toString('utf8').slice(0, 12000) : '';
    notes.push(extracted ? `File ${file.name}:\n${extracted}` : `File ${file.name}: no readable text.`);
  }
  const combined = [text.trim(), notes.join('\n\n')].filter((part) => part.length > 0).join('\n\n');
  return [{ type: 'text', text: combined }, ...images];
}
