export type NoteStatus = 'listening' | 'paused' | 'processing' | 'ready' | 'failed';

export type NoteErrorCode = 'upload' | 'stt' | 'gpt';

export type TranscriptTurn = {
  source: 'mic' | 'system' | 'mix';
  startSec: number;
  endSec: number;
  text: string;
};

export type WorkspaceResponse = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteResponse = {
  id: string;
  workspaceId: string;
  title: string | null;
  status: NoteStatus;
  summaryText: string[];
  transcriptText: string | null;
  transcriptTurns: TranscriptTurn[];
  language: 'en' | 'es' | null;
  errorCode: NoteErrorCode | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRow = {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
};

export type NoteRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  status: NoteStatus;
  summary_text: string | null;
  transcript_text: string | null;
  transcript_turns: string | null;
  language: 'en' | 'es' | null;
  error_code: NoteErrorCode | null;
  error_message: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
  updated_at: Date;
};

export function toWorkspace(row: WorkspaceRow): WorkspaceResponse {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toNote(row: NoteRow): NoteResponse {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    summaryText: splitSummary(row.summary_text),
    transcriptText: row.transcript_text,
    transcriptTurns: parseTurns(row.transcript_turns),
    language: row.language,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseTurns(value: string | null): TranscriptTurn[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const row = item as Partial<TranscriptTurn>;
      if (row.source !== 'mic' && row.source !== 'system' && row.source !== 'mix') {
        return [];
      }
      const text = typeof row.text === 'string' ? row.text.trim() : '';
      if (!text) {
        return [];
      }
      return [
        {
          source: row.source,
          startSec: Number(row.startSec) || 0,
          endSec: Number(row.endSec) || 0,
          text,
        },
      ];
    });
  } catch {
    return [];
  }
}

function splitSummary(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
