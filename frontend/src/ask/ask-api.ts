import { backendUrl } from '../env';

export type AskTurn = { role: 'user' | 'assistant'; text: string };

export type AskAttachment = { name: string; mime: string; dataBase64: string };

export class AskApi {
  constructor(
    private readonly url: () => string,
    private readonly token: () => Promise<string | null>,
  ) {}

  send(messages: AskTurn[], attachments: AskAttachment[]): Promise<{ answer: string }> {
    return this.request('/ask', { messages, attachments });
  }

  transcribe(dataBase64: string, mime: string, name: string): Promise<{ text: string }> {
    return this.request('/ask/voice', { dataBase64, mime, name });
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const access = await this.token();
    if (!access) {
      throw new Error('sign_in_required');
    }
    const response = await fetch(`${this.url().replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string | string[];
    };
    if (!response.ok) {
      const message = Array.isArray(payload.message) ? payload.message.join(', ') : payload.message;
      throw new Error(message || `ask_${response.status}`);
    }
    return payload as T;
  }
}

export function createAskApi(token: () => Promise<string | null>): AskApi {
  return new AskApi(backendUrl, token);
}
