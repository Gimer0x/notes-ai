import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureDevice, CaptureLevels, CaptureState } from './capture/capture.service';

type DevicePayload = CaptureDevice & { lost?: boolean };

type MePayload = {
  id: string;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
  remainingSeconds: number;
  remainingNotes: number | null;
  stale?: boolean;
};

type IpcFailure = { code?: string; retryable?: boolean };

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((result: unknown) => {
    if (result && typeof result === 'object' && 'pithResult' in result) {
      const envelope = result as unknown as {
        ok: boolean;
        data?: T;
        error?: IpcFailure;
      };
      if (!envelope.ok) {
        const error = new Error(envelope.error?.code || 'internal_error');
        (error as Error & { retryable?: boolean }).retryable = Boolean(envelope.error?.retryable);
        throw error;
      }
      return envelope.data as T;
    }
    return result as T;
  });
}

contextBridge.exposeInMainWorld('pith', {
  getLocale: (): Promise<'en' | 'es'> => call('i18n:locale'),
  getMessages: (locale: 'en' | 'es') => call('i18n:messages', locale),
  getConfig: (): Promise<{ minListenSeconds: number }> => call('config:get'),
  auth: {
    login: (): Promise<void> => call('auth:login'),
    logout: (): Promise<void> => call('auth:logout'),
    deleteAccount: (): Promise<void> => call('auth:deleteAccount'),
    me: (): Promise<MePayload | null> => call('auth:me'),
    upgrade: (): Promise<void> => call('billing:upgrade'),
    syncBilling: (): Promise<void> => call('billing:sync'),
  },
  capture: {
    preview: () => call('capture:preview'),
    start: () => call('capture:start'),
    pause: () => call('capture:pause'),
    resume: () => call('capture:resume'),
    stop: (noteId: string, typedNotes: string) =>
      call('debug:stopAndTranscribe', noteId, typedNotes),
    cancel: () => call('capture:cancel'),
    end: (): Promise<{ durationSeconds: number }> => call('capture:end'),
    getState: (): Promise<CaptureState> => call('capture:getState'),
    finalizing: (): Promise<boolean> => call('capture:finalizing'),
    pending: (): Promise<{ noteId: string; typedNotes?: string } | null> => call('capture:pending'),
    arm: (noteId: string): Promise<void> => call('capture:arm', noteId),
    disarm: (): Promise<void> => call('capture:disarm'),
    resend: () => call('debug:resend'),
    hasLastMix: (): Promise<boolean> => call('debug:hasLastMix'),
    onLevels: (listener: (levels: CaptureLevels) => void): (() => void) => {
      const handler = (_event: unknown, levels: CaptureLevels): void => {
        listener(levels);
      };
      ipcRenderer.on('capture:levels', handler);
      return () => {
        ipcRenderer.removeListener('capture:levels', handler);
      };
    },
    onDevice: (listener: (device: DevicePayload) => void): (() => void) => {
      const handler = (_event: unknown, device: DevicePayload): void => {
        listener(device);
      };
      ipcRenderer.on('capture:device', handler);
      return () => {
        ipcRenderer.removeListener('capture:device', handler);
      };
    },
    onSliceProgress: (listener: (progress: { done: number; total: number }) => void): (() => void) => {
      const handler = (_event: unknown, progress: { done: number; total: number }): void => {
        listener(progress);
      };
      ipcRenderer.on('slice:progress', handler);
      return () => {
        ipcRenderer.removeListener('slice:progress', handler);
      };
    },
  },
  permissions: {
    promptMicrophone: (): Promise<boolean> => call('permissions:microphone'),
  },
  notes: {
    listWorkspaces: () => call('notes:listWorkspaces'),
    createWorkspace: (name: string) => call('notes:createWorkspace', name),
    deleteWorkspace: (id: string) => call('notes:deleteWorkspace', id),
    setWorkspaceIcon: (id: string, icon: string) =>
      call('notes:setWorkspaceIcon', id, icon),
    listNotes: (workspaceId: string) => call('notes:listNotes', workspaceId),
    create: (workspaceId: string, title: string | null) =>
      call('notes:create', workspaceId, title),
    rename: (id: string, title: string | null) => call('notes:rename', id, title),
    move: (id: string, workspaceId: string) => call('notes:move', id, workspaceId),
    delete: (id: string) => call('notes:delete', id),
    cancel: (id: string) => call('notes:cancel', id),
    stop: (
      id: string,
      durationSeconds: number,
      transcriptText?: string | null,
      language?: 'en' | 'es' | null,
      turns?: {
        source: 'mic' | 'system' | 'mix';
        startSec: number;
        endSec: number;
        text: string;
      }[] | null,
    ) => call('notes:stop', id, durationSeconds, transcriptText, language, turns),
    retry: (id: string) => call('notes:retry', id),
    share: (id: string, emails: string[]) => call('notes:share', id, emails),
  },
  ask: {
    send: (
      messages: { role: 'user' | 'assistant'; text: string }[],
      attachments: { name: string; mime: string; dataBase64: string }[],
      noteId?: string | null,
    ) => call('ask:send', messages, attachments, noteId),
    transcribe: (dataBase64: string, mime: string, name: string) =>
      call('ask:transcribe', dataBase64, mime, name),
  },
  shell: {
    openSpike: (workspaceId: string, workspaceName: string): Promise<void> =>
      call('shell:openSpike', workspaceId, workspaceName),
    openNotepad: (keepProcessing?: boolean): Promise<void> =>
      call('shell:openNotepad', keepProcessing),
    openSite: (page: 'terms' | 'privacy'): Promise<void> =>
      call('shell:openSite', page),
  },
});

