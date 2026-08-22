import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureState } from './capture/capture.service';

contextBridge.exposeInMainWorld('pith', {
  getLocale: (): Promise<'en' | 'es'> => ipcRenderer.invoke('i18n:locale'),
  getMessages: (locale: 'en' | 'es') => ipcRenderer.invoke('i18n:messages', locale),
  capture: {
    start: () => ipcRenderer.invoke('capture:start'),
    pause: () => ipcRenderer.invoke('capture:pause'),
    resume: () => ipcRenderer.invoke('capture:resume'),
    stop: () => ipcRenderer.invoke('debug:stopAndTranscribe'),
    cancel: () => ipcRenderer.invoke('capture:cancel'),
    getState: (): Promise<CaptureState> => ipcRenderer.invoke('capture:getState'),
    resend: () => ipcRenderer.invoke('debug:resend'),
  },
});
