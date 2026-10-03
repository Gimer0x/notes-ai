import { backendUrl } from '../env';

export type WorkspaceRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteRecord = {
  id: string;
  workspaceId: string;
  title: string | null;
  status: 'listening' | 'paused' | 'processing' | 'ready' | 'failed';
  summaryText: string[];
  transcriptText: string | null;
  language: 'en' | 'es' | null;
  errorCode: 'upload' | 'stt' | 'gpt' | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
};

export class NotesApi {
  constructor(
    private readonly url: () => string,
    private readonly token: () => Promise<string | null>,
  ) {}

  listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.request('GET', '/workspaces');
  }

  createWorkspace(name: string): Promise<WorkspaceRecord> {
    return this.request('POST', '/workspaces', { name });
  }

  deleteWorkspace(id: string): Promise<void> {
    return this.request('DELETE', `/workspaces/${id}`);
  }

  listNotes(workspaceId: string): Promise<NoteRecord[]> {
    return this.request('GET', `/workspaces/${workspaceId}/notes`);
  }

  createNote(workspaceId: string, title: string | null): Promise<NoteRecord> {
    return this.request('POST', `/workspaces/${workspaceId}/notes`, { title });
  }

  renameNote(id: string, title: string | null): Promise<NoteRecord> {
    return this.request('PATCH', `/notes/${id}`, { title });
  }

  moveNote(id: string, workspaceId: string): Promise<NoteRecord> {
    return this.request('POST', `/notes/${id}/move`, { workspaceId });
  }

  deleteNote(id: string): Promise<void> {
    return this.request('DELETE', `/notes/${id}`);
  }

  cancelNote(id: string): Promise<void> {
    return this.request('POST', `/notes/${id}/cancel`);
  }

  stopNote(
    id: string,
    durationSeconds: number,
    transcriptText?: string | null,
    language?: 'en' | 'es' | null,
  ): Promise<NoteRecord> {
    return this.request('POST', `/notes/${id}/stop`, {
      durationSeconds,
      transcriptText: transcriptText ?? null,
      language: language ?? null,
    });
  }

  retryNote(id: string): Promise<NoteRecord> {
    return this.request('POST', `/notes/${id}/retry`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const access = await this.token();
    if (!access) {
      throw new Error('sign_in_required');
    }
    const response = await fetch(`${this.url().replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) {
      return undefined as T;
    }
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string | string[];
    };
    if (!response.ok) {
      const message = Array.isArray(payload.message)
        ? payload.message.join(', ')
        : payload.message;
      throw new Error(message || `notes_${response.status}`);
    }
    return payload as T;
  }
}

export function createNotesApi(
  token: () => Promise<string | null>,
): NotesApi {
  return new NotesApi(backendUrl, token);
}
