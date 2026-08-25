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
    getState: (): Promise<CaptureState> => ipcRenderer.invoke('capture:getState'),
    resend: () => ipcRenderer.invoke('debug:resend'),
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
});

