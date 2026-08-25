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
      remainingSeconds: number;
      remainingNotes: number | null;
    } | null>;
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
    onLevels: (listener: (levels: CaptureLevels) => void) => () => void;
    onDevice: (listener: (device: CaptureDevice) => void) => () => void;
  };
};

declare const pith: PithApi;

let locale: Locale = 'en';
let t: Messages = {};
let systemAudioEnabled: boolean | null = null;
let busy = false;
let awaitingTranscript = false;
let inputName = '';
let micLost = false;

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
  $('micLevelLabel').textContent = t.levelMic;
  $('sysLevelLabel').textContent = t.levelSystem;
  $('levelPill').setAttribute('aria-label', t.levelPillLabel);
  $('inputDeviceLabel').textContent = t.inputDevice;
  void renderAuth();
  renderSystemAudio();
  renderInputDevice();
}

function renderInputDevice(): void {
  $('inputDeviceName').textContent = inputName.trim() ? inputName : t.inputDeviceNone;
  $('deviceWarning').textContent = micLost ? t.errorMicLost : '';
}

function applyDevice(device: CaptureDevice): void {
  inputName = device.inputName || '';
  micLost = Boolean(device.lost);
  renderInputDevice();
}

async function renderAuth(): Promise<void> {
  const me = await pith.auth.me();
  $('authStatus').textContent = me
    ? t.signedInAs
        .replace('{email}', me.email)
        .replace('{plan}', me.plan === 'paid' ? t.planPaid : t.planFree)
    : t.signedOut;
  ($('signIn') as HTMLButtonElement).hidden = Boolean(me);
  ($('signOut') as HTMLButtonElement).hidden = !me;
  $('signIn').textContent = t.signIn;
  $('signOut').textContent = t.signOut;
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
    'no_google_client',
    'auth_denied',
    'auth_failed',
    'auth_timeout',
    'safe_storage_unavailable',
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
            : code === 'no_google_client'
              ? t.errorNoGoogleClient
              : code === 'auth_denied' ||
                  code === 'auth_failed' ||
                  code === 'auth_timeout' ||
                  code === 'safe_storage_unavailable'
                ? t.errorAuth
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
  const status = awaitingTranscript
    ? t.statusTranscribing
    : state === 'listening'
      ? t.statusListening
      : state === 'paused'
        ? t.statusPaused
        : t.statusMonitoring;
  $('status').textContent = status;
  $('levelPill').hidden = false;
}

const BAR_GAIN = [12, 16, 14];

function setBars(container: HTMLElement, level: number): void {
  const rest = (container.dataset.rest || '8,14,10')
    .split(',')
    .map((value) => Number(value));
  const bars = container.querySelectorAll('.bar');
  bars.forEach((bar, index) => {
    const base = rest[index] ?? 8;
    const gain = BAR_GAIN[index] ?? 12;
    (bar as HTMLElement).style.height = `${base + level * gain}px`;
  });
}

function applyLevels(levels: CaptureLevels): void {
  setBars($('micBars'), levels.mic);
  setBars($('sysBars'), levels.system);
  $('levelPill').setAttribute(
    'aria-valuenow',
    String(Math.max(levels.mic, levels.system).toFixed(2)),
  );
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
    awaitingTranscript = false;
    await syncButtons();
  }
}

async function init(): Promise<void> {
  locale = await pith.getLocale();
  t = await pith.getMessages(locale);
  applyCopy();
  pith.capture.onLevels(applyLevels);
  pith.capture.onDevice(applyDevice);
  await syncButtons();
  await withBusy(async () => {
    const result = await pith.capture.preview();
    systemAudioEnabled = result.systemAudioEnabled;
    applyDevice({ inputName: result.inputName, lost: !result.inputName });
    renderSystemAudio();
  });

  (document.getElementById('lang') as HTMLSelectElement).addEventListener(
    'change',
    async (event) => {
      locale = (event.target as HTMLSelectElement).value as Locale;
      t = await pith.getMessages(locale);
      applyCopy();
      await syncButtons();
    },
  );

  $('signIn').textContent = t.signIn;
  $('signOut').textContent = t.signOut;
  $('signIn').addEventListener('click', () =>
    withBusy(async () => {
      await pith.auth.login();
      await renderAuth();
    }),
  );
  $('signOut').addEventListener('click', () =>
    withBusy(async () => {
      await pith.auth.logout();
      await renderAuth();
    }),
  );
  $('start').addEventListener('click', () =>
    withBusy(async () => {
      const result = await pith.capture.start();
      systemAudioEnabled = result.systemAudioEnabled;
      applyDevice({ inputName: result.inputName, lost: !result.inputName });
      renderSystemAudio();
    }),
  );
  $('pause').addEventListener('click', () => withBusy(() => pith.capture.pause()));
  $('resume').addEventListener('click', () => withBusy(() => pith.capture.resume()));
  $('stop').addEventListener('click', () =>
    withBusy(async () => {
      awaitingTranscript = true;
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
      awaitingTranscript = true;
      $('status').textContent = t.statusTranscribing;
      const result = await pith.capture.resend();
      $('transcript').textContent = result.text.trim() ? result.text : t.noSpeech;
    }),
  );
}

void init();
