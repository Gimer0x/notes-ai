import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIError, toFile } from 'openai';
import { DbService } from '../db/db.service';
import { buildChatMessages, type AskFile, type AskTurn } from './ask.prompts';
import type { MeetingSnippet } from './meeting-context';

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_TURNS = 20;
const MAX_FILES = 4;
const MAX_FILE_BYTES = 1_200_000;
const MAX_VOICE_BYTES = 2_000_000;

const FILE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/pdf',
]);

@Injectable()
export class AskService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  async ask(userId: string, turns: AskTurn[], files: AskFile[]): Promise<{ answer: string }> {
    const history = cleanTurns(turns);
    const attachments = cleanFiles(files);
    if (process.env.NODE_ENV === 'test') {
      return { answer: history.at(-1)?.text ?? '' };
    }
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI_API_KEY is not set');
    }
    const model = this.config.get<string>('OPENAI_SUMMARY_MODEL')?.trim() || DEFAULT_MODEL;
    const meetings = await this.loadMeetings(userId);
    const openai = new OpenAI({ apiKey });
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        messages: buildChatMessages(
          meetings,
          history,
          attachments,
        ) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams['messages'],
      });
      const answer = completion.choices[0]?.message?.content?.trim() ?? '';
      if (!answer) {
        throw new BadGatewayException('empty_answer');
      }
      return { answer };
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

  async transcribeQuestion(
    dataBase64: string,
    mime: string,
    name: string,
  ): Promise<{ text: string }> {
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_VOICE_BYTES) {
      throw new BadRequestException('voice_too_large');
    }
    if (process.env.NODE_ENV === 'test') {
      return { text: 'voice' };
    }
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI_API_KEY is not set');
    }
    const model = this.config.get<string>('OPENAI_TRANSCRIBE_MODEL')?.trim() || 'gpt-4o-mini-transcribe';
    const openai = new OpenAI({ apiKey });
    const filename = name.trim() || 'question.webm';
    try {
      const file = await toFile(buffer, filename, { type: mime || 'audio/webm' });
      const result = await openai.audio.transcriptions.create({ file, model });
      return { text: (result.text ?? '').trim() };
    } catch (error) {
      if (error instanceof APIError) {
        throw new BadGatewayException(error.message);
      }
      throw error;
    }
  }

  private async loadMeetings(userId: string): Promise<MeetingSnippet[]> {
    const result = await this.db.query<{
      title: string | null;
      summary_text: string | null;
      transcript_text: string | null;
      created_at: Date;
      workspace_name: string;
    }>(
      `SELECT n.title, n.summary_text, n.transcript_text, n.created_at, w.name AS workspace_name
       FROM notes n
       JOIN workspaces w ON w.id = n.workspace_id
       WHERE n.user_id = $1
         AND (n.status = 'ready' OR (n.status = 'failed' AND n.transcript_text IS NOT NULL))
       ORDER BY n.created_at DESC
       LIMIT 40`,
      [userId],
    );
    return result.rows.map((row) => ({
      title: row.title ?? '',
      workspace: row.workspace_name,
      when: row.created_at.toISOString(),
      summary: row.summary_text ?? '',
      transcript: row.transcript_text ?? '',
    }));
  }
}

function cleanTurns(turns: AskTurn[]): AskTurn[] {
  if (!Array.isArray(turns) || turns.length === 0 || turns.length > MAX_TURNS) {
    throw new BadRequestException('ask_messages');
  }
  return turns.map((turn) => {
    const text = typeof turn?.text === 'string' ? turn.text.trim() : '';
    if ((turn?.role !== 'user' && turn?.role !== 'assistant') || !text || text.length > 8000) {
      throw new BadRequestException('ask_messages');
    }
    return { role: turn.role, text };
  });
}

function cleanFiles(files: AskFile[] | undefined): AskFile[] {
  if (!files || files.length === 0) {
    return [];
  }
  if (files.length > MAX_FILES) {
    throw new BadRequestException('ask_files');
  }
  return files.map((file) => {
    const mime = typeof file?.mime === 'string' ? file.mime.toLowerCase() : '';
    const dataBase64 = typeof file?.dataBase64 === 'string' ? file.dataBase64 : '';
    const name = typeof file?.name === 'string' ? file.name.slice(0, 120) : 'file';
    if (!FILE_TYPES.has(mime) || !dataBase64) {
      throw new BadRequestException('ask_file_type');
    }
    const bytes = Buffer.from(dataBase64, 'base64').length;
    if (bytes === 0 || bytes > MAX_FILE_BYTES) {
      throw new BadRequestException('ask_file_too_large');
    }
    return { name, mime, dataBase64 };
  });
}
