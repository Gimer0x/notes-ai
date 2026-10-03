type Locale = 'en' | 'es';
type Messages = Record<string, string>;
type CaptureLevels = { mic: number; system: number };
type CaptureDevice = { inputName: string; lost?: boolean };
type WorkspaceRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};
type NoteRecord = {
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

type PithApi = {
  getLocale: () => Promise<Locale>;
  getMessages: (locale: Locale) => Promise<Messages>;
  getConfig: () => Promise<{ minListenSeconds: number }>;
  auth: {
    login: () => Promise<void>;
    logout: () => Promise<void>;
    me: () => Promise<{
      id: string;
      email: string;
      displayName: string | null;
      plan: 'free' | 'paid';
      planInterval: 'month' | 'year' | null;
      remainingSeconds: number;
      remainingNotes: number | null;
    } | null>;
    upgrade: () => Promise<void>;
  };
  capture: {
    preview: () => Promise<{ systemAudioEnabled: boolean; inputName: string }>;
    start: () => Promise<{ systemAudioEnabled: boolean; inputName: string }>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    stop: () => Promise<{
      text: string;
      language: Locale;
      durationSeconds: number;
      systemAudioEnabled: boolean;
    }>;
    cancel: () => Promise<void>;
    end: () => Promise<{ durationSeconds: number }>;
    getState: () => Promise<'idle' | 'listening' | 'paused'>;
    resend: () => Promise<{ text: string; language: Locale }>;
    hasLastMix: () => Promise<boolean>;
    onLevels: (listener: (levels: CaptureLevels) => void) => () => void;
    onDevice: (listener: (device: CaptureDevice) => void) => () => void;
  };
  permissions: {
    promptMicrophone: () => Promise<boolean>;
  };
  notes: {
    listWorkspaces: () => Promise<WorkspaceRecord[]>;
    createWorkspace: (name: string) => Promise<WorkspaceRecord>;
    deleteWorkspace: (id: string) => Promise<void>;
    listNotes: (workspaceId: string) => Promise<NoteRecord[]>;
    create: (workspaceId: string, title: string | null) => Promise<NoteRecord>;
    rename: (id: string, title: string | null) => Promise<NoteRecord>;
    move: (id: string, workspaceId: string) => Promise<NoteRecord>;
    delete: (id: string) => Promise<void>;
    cancel: (id: string) => Promise<void>;
    stop: (
      id: string,
      durationSeconds: number,
      transcriptText?: string | null,
      language?: 'en' | 'es' | null,
    ) => Promise<NoteRecord>;
    retry: (id: string) => Promise<NoteRecord>;
  };
  shell: {
    openSpike: (workspaceId: string, workspaceName: string) => Promise<void>;
    openNotepad: () => Promise<void>;
  };
};

declare const pith: PithApi;
