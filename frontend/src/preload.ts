import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureLevels, CaptureState } from './capture/capture.service';

contextBridge.exposeInMainWorld('pith', {
  getLocale: (): Promise<'en' | 'es'> => ipcRenderer.invoke('i18n:locale'),
  getMessages: (locale: 'en' | 'es') => ipcRenderer.invoke('i18n:messages', locale),
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
  },
});
