type Locale = 'en' | 'es';
type Messages = Record<string, string>;

type PithApi = {
  getLocale: () => Promise<Locale>;
  getMessages: (locale: Locale) => Promise<Messages>;
  capture: {
    start: () => Promise<{ systemAudioEnabled: boolean }>;
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
  };
};

declare const pith: PithApi;

let locale: Locale = 'en';
let t: Messages = {};
let systemAudioEnabled: boolean | null = null;
let busy = false;

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function applyCopy(): void {
  document.documentElement.lang = locale;
  $('title').textContent = t.appTitle;
  document.title = t.appTitle;
  $('languageLabel').textContent = t.language;
  const lang = document.getElementById('lang') as HTMLSelectElement;
  lang.options[0].textContent = t.langEn;
  lang.options[1].textContent = t.langEs;
  lang.value = locale;
  $('start').textContent = t.start;
  $('pause').textContent = t.pause;
  $('resume').textContent = t.resume;
  $('stop').textContent = t.stop;
  $('cancel').textContent = t.cancel;
  $('resend').textContent = t.resend;
  $('permissionHint').textContent = t.permissionHint;
  $('grantAgain').textContent = t.grantAgain;
  $('transcriptLabel').textContent = t.transcript;
  renderSystemAudio();
}

function renderSystemAudio(): void {
  if (systemAudioEnabled === true) {
    $('systemAudio').textContent = t.systemAudioOn;
  } else if (systemAudioEnabled === false) {
    $('systemAudio').textContent = t.systemAudioOff;
  } else {
    $('systemAudio').textContent = '';
  }
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const known = [
    'helper_missing',
    'mic_denied',
    'macos_only',
    'no_spike_key',
    'empty',
    'too_short',
    'already_running',
    'not_listening',
  ];
  for (const code of known) {
    if (raw.includes(code)) {
      return code;
    }
  }
  return raw;
}

function setError(code: string): void {
  const mapped =
    code === 'helper_missing'
      ? t.errorHelperMissing
      : code === 'mic_denied'
        ? t.errorMicDenied
        : code === 'macos_only'
          ? t.errorMacosOnly
          : code === 'no_spike_key'
            ? t.errorNoKey
            : code === 'empty'
              ? t.errorEmpty
              : code === 'too_short'
                ? t.errorTooShort
                : code === 'mic_format'
                ? t.errorMicDenied
              : code.startsWith('spike_') || code.includes(' ')
                ? `${t.errorSpike}: ${code}`
                : t.errorGeneric;
  $('error').textContent = mapped;
}

async function syncButtons(): Promise<void> {
  const state = await pith.capture.getState();
  ($('start') as HTMLButtonElement).disabled = busy || state !== 'idle';
  ($('pause') as HTMLButtonElement).disabled = busy || state !== 'listening';
  ($('resume') as HTMLButtonElement).disabled = busy || state !== 'paused';
  ($('stop') as HTMLButtonElement).disabled =
    busy || (state !== 'listening' && state !== 'paused');
  ($('cancel') as HTMLButtonElement).disabled =
    busy || (state !== 'listening' && state !== 'paused');
  ($('resend') as HTMLButtonElement).disabled = busy;
  const status =
    busy && state === 'idle'
      ? t.statusTranscribing
      : state === 'listening'
        ? t.statusListening
        : state === 'paused'
          ? t.statusPaused
          : t.statusIdle;
  $('status').textContent = status;
}

async function withBusy(fn: () => Promise<void>): Promise<void> {
  busy = true;
  $('error').textContent = '';
  await syncButtons();
  try {
    await fn();
  } catch (error) {
    setError(errorCode(error));
  } finally {
    busy = false;
    await syncButtons();
  }
}

async function init(): Promise<void> {
  locale = await pith.getLocale();
  t = await pith.getMessages(locale);
  applyCopy();
  await syncButtons();

  (document.getElementById('lang') as HTMLSelectElement).addEventListener(
    'change',
    async (event) => {
      locale = (event.target as HTMLSelectElement).value as Locale;
      t = await pith.getMessages(locale);
      applyCopy();
      await syncButtons();
    },
  );

  $('start').addEventListener('click', () =>
    withBusy(async () => {
      const result = await pith.capture.start();
      systemAudioEnabled = result.systemAudioEnabled;
      renderSystemAudio();
    }),
  );
  $('pause').addEventListener('click', () => withBusy(() => pith.capture.pause()));
  $('resume').addEventListener('click', () => withBusy(() => pith.capture.resume()));
  $('stop').addEventListener('click', () =>
    withBusy(async () => {
      $('status').textContent = t.statusTranscribing;
      const result = await pith.capture.stop();
      systemAudioEnabled = result.systemAudioEnabled;
      renderSystemAudio();
      $('transcript').textContent = result.text.trim() ? result.text : t.noSpeech;
      $('duration').textContent = `${t.duration}: ${result.durationSeconds.toFixed(1)}s`;
    }),
  );
  $('cancel').addEventListener('click', () => withBusy(() => pith.capture.cancel()));
  $('resend').addEventListener('click', () =>
    withBusy(async () => {
      $('status').textContent = t.statusTranscribing;
      const result = await pith.capture.resend();
      $('transcript').textContent = result.text.trim() ? result.text : t.noSpeech;
    }),
  );
}

void init();
