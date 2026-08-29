type Locale = 'en' | 'es';
type Messages = Record<string, string>;
type CaptureLevels = { mic: number; system: number };
type CaptureDevice = { inputName: string; lost?: boolean };

type PithApi = {
  getLocale: () => Promise<Locale>;
  getMessages: (locale: Locale) => Promise<Messages>;
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
    getState: () => Promise<'idle' | 'listening' | 'paused'>;
    resend: () => Promise<{ text: string; language: Locale }>;
    hasLastMix: () => Promise<boolean>;
    onLevels: (listener: (levels: CaptureLevels) => void) => () => void;
    onDevice: (listener: (device: CaptureDevice) => void) => () => void;
  };
  shell: {
    openSpike: () => Promise<void>;
    openNotepad: () => Promise<void>;
  };
};

declare const pith: PithApi;
