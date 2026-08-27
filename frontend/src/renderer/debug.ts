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
  $('durationLabel').textContent = t.duration;
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
  renderDuration();
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

function planLabel(me: {
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
}): string {
  if (me.plan !== 'paid') {
    return t.planFree;
  }
  if (me.planInterval === 'year') {
    return t.planPaidYearly;
  }
  if (me.planInterval === 'month') {
    return t.planPaidMonthly;
  }
  return t.planPaid;
}

async function renderAuth(): Promise<void> {
  const me = await pith.auth.me();
  $('authStatus').textContent = me
    ? t.signedInAs.replace('{email}', me.email).replace('{plan}', planLabel(me))
    : t.signedOut;
  ($('signIn') as HTMLButtonElement).hidden = Boolean(me);
  ($('signOut') as HTMLButtonElement).hidden = !me;
  $('signIn').textContent = t.signIn;
  $('signOut').textContent = t.signOut;
  $('upgrade').textContent = t.upgrade;
  ($('upgrade') as HTMLButtonElement).hidden = !me || me.plan === 'paid';
  if (!me) {
    $('quota').textContent = '';
    return;
  }
  const minutes = Math.floor(me.remainingSeconds / 60);
  const notesLine =
    me.remainingNotes === null
      ? t.remainingNotesUnlimited
      : t.remainingNotesCount.replace('{count}', String(me.remainingNotes));
  $('quota').textContent = `${t.remainingTime.replace('{minutes}', String(minutes))} · ${notesLine}`;
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
    'File too large',
    'no_last_mix',
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
                : code === 'File too large'
                  ? t.errorFileTooLarge
                  : code === 'no_last_mix'
                    ? t.errorNoLastMix
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
  const hasLastMix = await pith.capture.hasLastMix();
  ($('start') as HTMLButtonElement).disabled = busy || state !== 'idle';
  ($('pause') as HTMLButtonElement).disabled = busy || state !== 'listening';
  ($('resume') as HTMLButtonElement).disabled = busy || state !== 'paused';
  ($('stop') as HTMLButtonElement).disabled =
    busy || (state !== 'listening' && state !== 'paused');
  ($('cancel') as HTMLButtonElement).disabled =
    busy || (state !== 'listening' && state !== 'paused');
  ($('resend') as HTMLButtonElement).disabled = busy || !hasLastMix;
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

function formatClock(totalSeconds: number): string {
  const whole = Math.floor(Math.max(0, totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

let recordedMs = 0;
let runningSince: number | null = null;
let tickId: number | null = null;

function recordedSeconds(): number {
  const extra = runningSince == null ? 0 : Date.now() - runningSince;
  return (recordedMs + extra) / 1000;
}

function renderDuration(seconds = recordedSeconds()): void {
  const clock = formatClock(seconds);
  const el = $('duration');
  el.textContent = clock;
  el.setAttribute('datetime', `PT${Math.floor(Math.max(0, seconds))}S`);
  el.setAttribute('data-running', runningSince != null ? 'true' : 'false');
}

function ensureTicker(): void {
  if (tickId != null) {
    return;
  }
  tickId = window.setInterval(() => renderDuration(), 200);
}

function stopTicker(): void {
  if (tickId != null) {
    clearInterval(tickId);
    tickId = null;
  }
}

function resetTimer(): void {
  recordedMs = 0;
  runningSince = null;
  stopTicker();
  renderDuration(0);
}

function pauseTimer(): void {
  if (runningSince != null) {
    recordedMs += Date.now() - runningSince;
    runningSince = null;
  }
  stopTicker();
  renderDuration();
}

function resumeTimer(): void {
  if (runningSince == null) {
    runningSince = Date.now();
  }
  ensureTicker();
  renderDuration();
}

function startTimer(): void {
  recordedMs = 0;
  runningSince = Date.now();
  ensureTicker();
  renderDuration();
}

function freezeTimer(seconds: number): void {
  recordedMs = Math.max(0, seconds) * 1000;
  runningSince = null;
  stopTicker();
  renderDuration(seconds);
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
  $('upgrade').addEventListener('click', () =>
    withBusy(async () => {
      await pith.auth.upgrade();
    }),
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void renderAuth();
    }
  });
  $('start').addEventListener('click', () =>
    withBusy(async () => {
      try {
        const result = await pith.capture.start();
        startTimer();
        systemAudioEnabled = result.systemAudioEnabled;
        applyDevice({ inputName: result.inputName, lost: !result.inputName });
        renderSystemAudio();
      } catch (error) {
        resetTimer();
        throw error;
      }
    }),
  );
  $('pause').addEventListener('click', () =>
    withBusy(async () => {
      pauseTimer();
      try {
        await pith.capture.pause();
      } catch (error) {
        resumeTimer();
        throw error;
      }
    }),
  );
  $('resume').addEventListener('click', () =>
    withBusy(async () => {
      resumeTimer();
      try {
        await pith.capture.resume();
      } catch (error) {
        pauseTimer();
        throw error;
      }
    }),
  );
  $('stop').addEventListener('click', () =>
    withBusy(async () => {
      pauseTimer();
      awaitingTranscript = true;
      $('status').textContent = t.statusTranscribing;
      const result = await pith.capture.stop();
      systemAudioEnabled = result.systemAudioEnabled;
      renderSystemAudio();
      $('transcript').textContent = result.text.trim() ? result.text : t.noSpeech;
      freezeTimer(result.durationSeconds);
    }),
  );
  $('cancel').addEventListener('click', () =>
    withBusy(async () => {
      pauseTimer();
      try {
        await pith.capture.cancel();
        resetTimer();
      } catch (error) {
        resumeTimer();
        throw error;
      }
    }),
  );
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
