let locale: Locale = 'en';
let t: Messages = {};
let busy = false;
let awaitingTranscript = false;
let inputName = '';
let micLost = false;
let lastDefaultTitle = '';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function applyCopy(): void {
  document.documentElement.lang = locale;
  const title = document.getElementById('noteTitle') as HTMLInputElement;
  title.placeholder = t.newNote;
  title.setAttribute('aria-label', t.noteTitleLabel);
  if (!title.value.trim() || title.value === lastDefaultTitle) {
    title.value = t.newNote;
  }
  lastDefaultTitle = t.newNote;
  document.title = title.value.trim() || t.newNote;
  $('listenToggle').textContent = t.stop;
  $('generate').textContent = t.generate;
  $('duration').setAttribute('aria-label', t.duration);
  $('backToNotepad').setAttribute('aria-label', t.home);
  $('spikeMore').setAttribute('aria-label', t.moreActions);
  $('moveToTrash').textContent = t.moveToTrash;
  const notes = document.getElementById('noteBody') as HTMLTextAreaElement;
  notes.setAttribute('aria-label', t.listenNotesLabel);
  notes.placeholder = t.listenNotesPlaceholder;
  $('levelPill').setAttribute('aria-label', t.levelPillLabel);
  renderInputDevice();
  renderDuration();
}

function renderInputDevice(): void {
  $('deviceWarning').textContent = micLost ? t.errorMicLost : '';
}

function noteBody(): HTMLTextAreaElement {
  return document.getElementById('noteBody') as HTMLTextAreaElement;
}

function applyGeneratedText(transcript: string): void {
  const typed = noteBody().value.trim();
  const speech = transcript.trim() ? transcript.trim() : t.noSpeech;
  const body = noteBody();
  body.value = typed ? `${t.myNotesHeading}\n\n${typed}\n\n${speech}` : speech;
  body.scrollTop = 0;
  body.setSelectionRange(0, 0);
}

function closeSpikeMenu(): void {
  $('spikeMenuPop').hidden = true;
  $('spikeMore').setAttribute('aria-expanded', 'false');
}

async function moveToTrash(): Promise<void> {
  closeSpikeMenu();
  const state = await pith.capture.getState();
  if (state === 'listening' || state === 'paused') {
    await withBusy(async () => {
      pauseTimer();
      await pith.capture.cancel();
      resetTimer();
    });
    const next = await pith.capture.getState();
    if (next !== 'idle') {
      return;
    }
  }
  pith.shell.openNotepad();
}

function applyDevice(device: CaptureDevice): void {
  inputName = device.inputName || '';
  micLost = Boolean(device.lost);
  renderInputDevice();
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
  const toggle = $('listenToggle') as HTMLButtonElement;
  const generate = $('generate') as HTMLButtonElement;
  toggle.textContent = state === 'paused' ? t.resume : t.stop;
  toggle.disabled = busy || (state !== 'listening' && state !== 'paused');
  generate.disabled = busy || (state !== 'listening' && state !== 'paused');
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

const BAR_REST = [0.28, 0.45, 0.32];
const BAR_PEAK = [0.78, 1, 0.86];

function setBars(container: HTMLElement, level: number): void {
  const max = container.clientHeight;
  if (max <= 0) {
    return;
  }
  const clamped = Math.min(1, Math.max(0, level));
  const bars = container.querySelectorAll('.bar');
  bars.forEach((bar, index) => {
    const rest = BAR_REST[index] ?? 0.3;
    const peak = BAR_PEAK[index] ?? 1;
    (bar as HTMLElement).style.height = `${(rest + (peak - rest) * clamped) * max}px`;
  });
}

function applyLevels(levels: CaptureLevels): void {
  const mixed = Math.max(levels.mic, levels.system);
  setBars($('mixBars'), mixed);
  $('levelPill').setAttribute('aria-valuenow', String(mixed.toFixed(2)));
}

async function startRecording(): Promise<void> {
  const result = await pith.capture.start();
  startTimer();
  applyDevice({ inputName: result.inputName, lost: !result.inputName });
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
    const preview = await pith.capture.preview();
    applyDevice({ inputName: preview.inputName, lost: !preview.inputName });
    try {
      await startRecording();
    } catch (error) {
      resetTimer();
      throw error;
    }
  });

  $('backToNotepad').addEventListener('click', () => pith.shell.openNotepad());
  const title = document.getElementById('noteTitle') as HTMLInputElement;
  title.addEventListener('focus', () => {
    if (title.value === t.newNote) {
      title.select();
    }
  });
  title.addEventListener('input', () => {
    document.title = title.value.trim() || t.newNote;
  });
  $('spikeMore').addEventListener('click', (event) => {
    event.stopPropagation();
    const pop = $('spikeMenuPop');
    const willOpen = pop.hidden;
    closeSpikeMenu();
    if (willOpen) {
      pop.hidden = false;
      $('spikeMore').setAttribute('aria-expanded', 'true');
    }
  });
  $('spikeMenu').addEventListener('click', (event) => event.stopPropagation());
  $('moveToTrash').addEventListener('click', (event) => {
    event.stopPropagation();
    void moveToTrash();
  });
  document.addEventListener('click', () => closeSpikeMenu());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSpikeMenu();
    }
  });
  $('listenToggle').addEventListener('click', () =>
    withBusy(async () => {
      const state = await pith.capture.getState();
      if (state === 'listening') {
        pauseTimer();
        try {
          await pith.capture.pause();
        } catch (error) {
          resumeTimer();
          throw error;
        }
        return;
      }
      if (state === 'paused') {
        resumeTimer();
        try {
          await pith.capture.resume();
        } catch (error) {
          pauseTimer();
          throw error;
        }
      }
    }),
  );
  $('generate').addEventListener('click', () =>
    withBusy(async () => {
      pauseTimer();
      awaitingTranscript = true;
      const result = await pith.capture.stop();
      applyGeneratedText(result.text);
      freezeTimer(result.durationSeconds);
    }),
  );
}

void init();

export {};
