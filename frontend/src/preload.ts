import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureDevice, CaptureLevels, CaptureState } from './capture/capture.service';

type DevicePayload = CaptureDevice & { lost?: boolean };

type MePayload = {
  id: string;
  email: string;
  displayName: string | null;
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
  remainingSeconds: number;
  remainingNotes: number | null;
};

contextBridge.exposeInMainWorld('pith', {
  getLocale: (): Promise<'en' | 'es'> => ipcRenderer.invoke('i18n:locale'),
  getMessages: (locale: 'en' | 'es') => ipcRenderer.invoke('i18n:messages', locale),
  getConfig: (): Promise<{ minListenSeconds: number }> => ipcRenderer.invoke('config:get'),
  auth: {
    login: (): Promise<void> => ipcRenderer.invoke('auth:login'),
    logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
    me: (): Promise<MePayload | null> => ipcRenderer.invoke('auth:me'),
    upgrade: (): Promise<void> => ipcRenderer.invoke('billing:upgrade'),
  },
  capture: {
    preview: () => ipcRenderer.invoke('capture:preview'),
    start: () => ipcRenderer.invoke('capture:start'),
    pause: () => ipcRenderer.invoke('capture:pause'),
    resume: () => ipcRenderer.invoke('capture:resume'),
    stop: () => ipcRenderer.invoke('debug:stopAndTranscribe'),
    cancel: () => ipcRenderer.invoke('capture:cancel'),
    end: (): Promise<{ durationSeconds: number }> => ipcRenderer.invoke('capture:end'),
    getState: (): Promise<CaptureState> => ipcRenderer.invoke('capture:getState'),
    resend: () => ipcRenderer.invoke('debug:resend'),
    hasLastMix: (): Promise<boolean> => ipcRenderer.invoke('debug:hasLastMix'),
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
  },
  permissions: {
    promptMicrophone: (): Promise<boolean> => ipcRenderer.invoke('permissions:microphone'),
  },
  notes: {
    listWorkspaces: () => ipcRenderer.invoke('notes:listWorkspaces'),
    createWorkspace: (name: string) => ipcRenderer.invoke('notes:createWorkspace', name),
    deleteWorkspace: (id: string) => ipcRenderer.invoke('notes:deleteWorkspace', id),
    listNotes: (workspaceId: string) => ipcRenderer.invoke('notes:listNotes', workspaceId),
    create: (workspaceId: string, title: string | null) =>
      ipcRenderer.invoke('notes:create', workspaceId, title),
    rename: (id: string, title: string | null) => ipcRenderer.invoke('notes:rename', id, title),
    move: (id: string, workspaceId: string) => ipcRenderer.invoke('notes:move', id, workspaceId),
    delete: (id: string) => ipcRenderer.invoke('notes:delete', id),
    cancel: (id: string) => ipcRenderer.invoke('notes:cancel', id),
    stop: (
      id: string,
      durationSeconds: number,
      transcriptText?: string | null,
      language?: 'en' | 'es' | null,
    ) => ipcRenderer.invoke('notes:stop', id, durationSeconds, transcriptText, language),
    retry: (id: string) => ipcRenderer.invoke('notes:retry', id),
  },
  shell: {
    openSpike: (workspaceId: string, workspaceName: string): Promise<void> =>
      ipcRenderer.invoke('shell:openSpike', workspaceId, workspaceName),
    openNotepad: (): Promise<void> => ipcRenderer.invoke('shell:openNotepad'),
  },
});

