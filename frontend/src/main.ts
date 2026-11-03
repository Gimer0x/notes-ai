import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, systemPreferences } from 'electron';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { AuthService } from './auth/auth.service';
import type { CaptureDevice, CaptureLevels } from './capture/capture.service';
import { segmentTracks, splitLongSegments } from './capture/segment-tracks';
import { captureFiles, prepareBatch, type CaptureFiles, type PreparedBatch } from './capture/upload-queue';
import { CaptureQueue } from './capture/capture-queue';
import { requestScreenCaptureAccess } from './capture/helper-client';
import { NativeCaptureService } from './capture/native-capture.service';
import { backendUrl, captureSpikeKey, loadFrontendEnv, websiteUrl } from './env';
import { resetSessionTrace, trace, writeSessionTrace, type TraceSegment } from './debug/session-trace';
import { createAskApi } from './ask/ask-api';
import { createNotesApi, type NoteRecord } from './notes/notes-api';
import { SpikeClient, SpikeRequestError } from './spike/spike-client';
import en from './i18n/en.json';
import es from './i18n/es.json';

loadFrontendEnv();

type IpcError = { code: string; message: string; retryable: boolean };

function toIpcError(error: unknown): IpcError {
  const raw = error instanceof Error ? error.message : '';
  const code = /^[a-z0-9_]+$/i.test(raw) ? raw : 'internal_error';
  const retryable =
    code === 'upload_paused' ||
    code === 'backend_unavailable' ||
    code === 'request_timeout' ||
    code === 'slices_missing' ||
    code === 'summary_failed' ||
    code === 'summary_unavailable' ||
    code === 'transcription_unavailable' ||
    code === 'google_unavailable' ||
    code === 'billing_sync_failed' ||
    code === 'stripe_unavailable';
  return { code, message: code, retryable };
}

function handleIpc(channel: string, listener: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (...args) => {
    try {
      const data = await listener(...args);
      return { pithResult: true, ok: true, data };
    } catch (error) {
      console.error(JSON.stringify({ event: 'ipc', channel, ...toIpcError(error) }));
      return { pithResult: true, ok: false, error: toIpcError(error) };
    }
  });
}

const capture = new NativeCaptureService();
capture.subscribeHelperLog((chunk) => trace('helper', chunk));
const spike = new SpikeClient(backendUrl(), captureSpikeKey());
const auth = new AuthService();
const notesApi = createNotesApi(() => auth.getAccessToken());
const askApi = createAskApi(() => auth.getAccessToken());
let lastMix: Buffer | null = null;
let lastMic: Buffer | null = null;
let lastSystem: Buffer | null = null;
let lastSystemAudioEnabled = false;
let lastInputName = '';
let mainWindow: BrowserWindow | null = null;

function rememberSession(result: { systemAudioEnabled: boolean; inputName: string }): void {
  lastSystemAudioEnabled = result.systemAudioEnabled;
  lastInputName = result.inputName;
}

function beginNote(): void {
  lastMix = null;
  lastMic = null;
  lastSystem = null;
  resetSessionTrace();
}

function logFrontend(line: string): void {
  const text = line.endsWith('\n') ? line : `${line}\n`;
  process.stderr.write(text);
  trace('frontend', text);
}

let lastLoggedMinListen: number | undefined;

async function loadAppConfig(): Promise<{
  minListenSeconds: number;
  pauseAutoCancelSeconds: number;
  pauseWarningSeconds: number;
  uploadRetrySeconds: number;
  wavChunkSeconds: number;
}> {
  const response = await fetch(`${backendUrl().replace(/\/$/, '')}/config`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error('config_failed');
  }
  const body = (await response.json()) as {
    minListenSeconds?: number;
    pauseAutoCancelSeconds?: number;
    pauseWarningSeconds?: number;
    uploadRetrySeconds?: number;
    wavChunkSeconds?: number;
  };
  const minListenSeconds = Number(body.minListenSeconds);
  const pauseAutoCancelSeconds = Number(body.pauseAutoCancelSeconds);
  const pauseWarningSeconds = Number(body.pauseWarningSeconds);
  const uploadRetrySeconds = Number(body.uploadRetrySeconds);
  const wavChunkSeconds = Number(body.wavChunkSeconds);
  if (
    !Number.isFinite(minListenSeconds) ||
    minListenSeconds <= 0 ||
    !Number.isFinite(pauseAutoCancelSeconds) ||
    pauseAutoCancelSeconds <= 0
  ) {
    throw new Error('config_failed');
  }
  if (lastLoggedMinListen !== minListenSeconds) {
    lastLoggedMinListen = minListenSeconds;
    logFrontend(`config minListenSeconds=${minListenSeconds}`);
  }
  return {
    minListenSeconds,
    pauseAutoCancelSeconds,
    pauseWarningSeconds: Number.isFinite(pauseWarningSeconds) ? pauseWarningSeconds : 0,
    uploadRetrySeconds: Number.isFinite(uploadRetrySeconds) ? uploadRetrySeconds : 0,
    wavChunkSeconds: Number.isFinite(wavChunkSeconds) ? wavChunkSeconds : 0,
  };
}

function previewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function transcribeNote(files: {
  mix: Buffer;
  mic: Buffer | null;
  system: Buffer | null;
}): Promise<{
  text: string;
  language: 'en' | 'es';
  segments: TraceSegment[];
  logs: string[];
  turns: { source: 'mic' | 'system' | 'mix'; startSec: number; endSec: number; text: string }[];
}> {
  const started = Date.now();
  const segments = segmentTracks(files.mic, files.system, files.mix);
  logFrontend(`spike segments=${segments.length}`);
  const toSend =
    segments.length > 0
      ? segments
      : [
          {
            source: 'mix' as const,
            startSec: 0,
            endSec: 0,
            peak: 0,
            wav: files.mix,
          },
        ];

  const texts: string[] = [];
  const noted: TraceSegment[] = [];
  const turns: { source: 'mic' | 'system' | 'mix'; startSec: number; endSec: number; text: string }[] =
    [];
  const logs: string[] = [];
  let language: 'en' | 'es' = 'en';
  try {
    for (const [index, segment] of toSend.entries()) {
      const row: TraceSegment = {
        index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        source: segment.source,
        peak: segment.peak,
        bytes: segment.wav.length,
      };
      logFrontend(
        `spike segment ${index} ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}s source=${segment.source} peak=${segment.peak} bytes=${segment.wav.length}`,
      );
      const result = await spike.transcribe(segment.wav, `${segment.source}-${index}.wav`);
      logs.push(...result.logs);
      const preview = previewText(result.text);
      row.language = result.language;
      row.chars = result.text.length;
      row.preview = preview;
      noted.push(row);
      logFrontend(
        `spike segment ${index} lang=${result.language} chars=${result.text.length} preview=${preview}`,
      );
      if (result.text.trim()) {
        const spoken = result.text.trim();
        texts.push(spoken);
        const source = segment.source === 'mic' || segment.source === 'system' ? segment.source : 'mix';
        turns.push({
          source,
          startSec: segment.startSec,
          endSec: segment.endSec,
          text: spoken,
        });
        language = result.language;
      }
    }
  } catch (error) {
    if (error instanceof SpikeRequestError) {
      logs.push(...error.logs);
    }
    const failed = error instanceof Error ? error : new Error('transcribe_failed');
    Object.assign(failed, { segments: noted, logs });
    throw failed;
  }
  logFrontend(
    `spike done segments=${toSend.length} chars=${texts.join('\n\n').length} ms=${Date.now() - started}`,
  );
  return { text: texts.join('\n\n').trim(), language, segments: noted, logs, turns };
}

function rendererFile(name: string): string {
  return path.join(__dirname, 'renderer', name);
}

function broadcastLevels(levels: CaptureLevels): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('capture:levels', levels);
  }
}

function broadcastDevice(device: CaptureDevice): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('capture:device', {
      inputName: device.inputName,
      lost: capture.isMicLost(),
    });
  }
}

capture.subscribeLevels(broadcastLevels);
capture.subscribeDevice(broadcastDevice);

function preferredLocale(): 'en' | 'es' {
  return app.getLocale().toLowerCase().startsWith('es') ? 'es' : 'en';
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1210,
    height: 840,
    title: 'Pith',
    backgroundColor: '#FAF7F1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadFile(rendererFile('shell.html'));
}

handleIpc('shell:openSpike', async (_event, workspaceId: string, workspaceName: string) => {
  assertCaptureAvailable();
  const user = await signedInUser();
  assertCaptureAvailable();
  if (!user) {
    throw new Error('sign_in_required');
  }
  beginNote();
  if (finalizingNoteId === null) {
    try {
      await capture.cancel();
    } catch {
      // Helper may not be running yet.
    }
  }
  if (mainWindow) {
    void mainWindow.loadFile(rendererFile('index.html'), {
      query: {
        note: String(Date.now()),
        workspaceId: workspaceId ?? '',
        workspaceName: workspaceName ?? '',
      },
    });
  }
});
handleIpc('shell:openNotepad', async (_event, keepProcessing?: boolean) => {
  beginNote();
  if (!keepProcessing && finalizingNoteId === null) {
    try {
      await capture.cancel();
    } catch {
      // Helper may not be running yet.
    }
  }
  if (mainWindow) {
    void mainWindow.loadFile(rendererFile('shell.html'));
  }
});
handleIpc('shell:openSite', async (_event, page: string) => {
  if (page !== 'terms' && page !== 'privacy') {
    return;
  }
  await shell.openExternal(`${websiteUrl()}/${page}`);
});
handleIpc('i18n:locale', () => preferredLocale());
handleIpc('i18n:messages', (_event, locale: 'en' | 'es') => {
  return locale === 'es' ? es : en;
});
handleIpc('config:get', () => loadAppConfig());
handleIpc('auth:login', () => auth.login());
handleIpc('auth:logout', () => auth.logout());
handleIpc('auth:deleteAccount', async () => {
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error('sign_in_required');
  }
  const response = await fetch(`${backendUrl()}/me`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(payload.message || 'delete_account_failed');
  }
  await auth.logout();
});
type CachedMe = Record<string, unknown> & { stale?: boolean };

function meCachePath(): string {
  return path.join(app.getPath('userData'), 'me-cache.json');
}

async function readCachedMe(): Promise<CachedMe | null> {
  try {
    const parsed = JSON.parse(await readFile(meCachePath(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as CachedMe;
  } catch {
    return null;
  }
}

async function signedInUser(): Promise<CachedMe | null> {
  const token = await auth.getAccessToken();
  if (!token) {
    await unlink(meCachePath()).catch(() => undefined);
    return null;
  }
  try {
    const response = await fetch(`${backendUrl()}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      await unlink(meCachePath()).catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      const cached = await readCachedMe();
      if (cached) {
        return { ...cached, stale: true };
      }
      throw new Error('backend_unavailable');
    }
    const me = (await response.json()) as CachedMe;
    delete me.stale;
    await mkdir(path.dirname(meCachePath()), { recursive: true }).catch(() => undefined);
    await writeFile(meCachePath(), JSON.stringify(me));
    return me;
  } catch (error) {
    if (error instanceof Error && error.message === 'backend_unavailable') {
      throw error;
    }
    const cached = await readCachedMe();
    if (cached) {
      return { ...cached, stale: true };
    }
    throw new Error('backend_unavailable');
  }
}

handleIpc('auth:me', () => signedInUser());
handleIpc('billing:sync', async () => {
  const token = await auth.getAccessToken();
  if (!token) {
    return;
  }
  const response = await fetch(`${backendUrl()}/billing/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 401) {
    throw new Error('billing_sync_failed');
  }
});
handleIpc('billing:upgrade', async () => {
  await shell.openExternal(`${websiteUrl()}/pricing`);
});
handleIpc('capture:preview', async () => {
  const result = await capture.preview();
  rememberSession(result);
  return result;
});
handleIpc('capture:start', async () => {
  assertCaptureAvailable();
  const result = await capture.start();
  rememberSession(result);
  return result;
});
handleIpc('permissions:microphone', async () => {
  if (process.platform !== 'darwin') {
    return false;
  }
  const status = systemPreferences.getMediaAccessStatus('microphone');
  process.stderr.write(`mic permission status=${status}\n`);
  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (granted) {
      return true;
    }
  }
  await openMicrophoneSettings();
  return false;
});
handleIpc('capture:pause', () => capture.pause());
handleIpc('capture:resume', () => capture.resume());
handleIpc('capture:cancel', async () => {
  assertCaptureAvailable();
  beginNote();
  await resetExport();
  await capture.cancel();
});
handleIpc('capture:end', async () => {
  assertCaptureAvailable();
  await resetExport();
  const captured = await capture.stop();
  await unlink(captured.filePath).catch(() => undefined);
  if (captured.micFilePath) {
    await unlink(captured.micFilePath).catch(() => undefined);
  }
  if (captured.systemFilePath) {
    await unlink(captured.systemFilePath).catch(() => undefined);
  }
  const durationSeconds = Number(captured.durationSeconds);
  return { durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0 };
});
handleIpc('notes:listWorkspaces', () => notesApi.listWorkspaces());
handleIpc('notes:createWorkspace', (_event, name: string) => notesApi.createWorkspace(name));
handleIpc('notes:deleteWorkspace', (_event, id: string) => notesApi.deleteWorkspace(id));
handleIpc('notes:setWorkspaceIcon', (_event, id: string, icon: string) =>
  notesApi.setWorkspaceIcon(id, icon),
);
handleIpc('notes:listNotes', (_event, workspaceId: string) => notesApi.listNotes(workspaceId));
handleIpc('notes:create', (_event, workspaceId: string, title: string | null) =>
  notesApi.createNote(workspaceId, title),
);
handleIpc('notes:rename', (_event, id: string, title: string | null) =>
  notesApi.renameNote(id, title),
);
handleIpc('notes:move', (_event, id: string, workspaceId: string) =>
  notesApi.moveNote(id, workspaceId),
);
handleIpc('notes:delete', (_event, id: string) => notesApi.deleteNote(id));
handleIpc('notes:cancel', (_event, id: string) => notesApi.cancelNote(id));
handleIpc(
  'notes:stop',
  (
    _event,
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
  ) => notesApi.stopNote(id, durationSeconds, transcriptText, language, turns),
);
handleIpc('notes:retry', (_event, id: string) => notesApi.retryNote(id));
handleIpc('notes:share', (_event, id: string, emails: string[]) =>
  notesApi.shareNote(id, emails),
);
handleIpc(
  'ask:send',
  (
    _event,
    messages: { role: 'user' | 'assistant'; text: string }[],
    attachments: { name: string; mime: string; dataBase64: string }[],
    noteId?: string | null,
  ) => askApi.send(messages, attachments, noteId),
);
handleIpc(
  'ask:transcribe',
  (_event, dataBase64: string, mime: string, name: string) =>
    askApi.transcribe(dataBase64, mime, name),
);
let exportTimer: ReturnType<typeof setInterval> | null = null;
let exportChain: Promise<void> = Promise.resolve();
let finalizingNoteId: string | null = null;
const generations = new Map<string, Promise<NoteRecord>>();
const uploadQueue = new CaptureQueue({
  root: () => path.join(app.getPath('userData'), 'capture-queue'),
  prepare: materialize,
  upload: (noteId, piece) => notesApi.uploadSlice(
    noteId, piece.seq, piece.source, piece.startSec, piece.endSec, piece.wav,
  ),
});

function assertCaptureAvailable(): void {
  if (finalizingNoteId) throw new Error('capture_finishing');
}

function stopExportTimer(): void {
  if (exportTimer) {
    clearInterval(exportTimer);
    exportTimer = null;
  }
}

async function resetExport(noteId = uploadQueue.noteId): Promise<void> {
  if (noteId !== uploadQueue.noteId) return;
  stopExportTimer();
  await exportChain;
  await uploadQueue.clear(noteId ?? undefined);
}

async function materialize(captured: CaptureFiles, nextSliceSeq: number, audioOffsetSec: number): Promise<PreparedBatch | null> {
  const mix = await readFile(captured.filePath);
  const mic = captured.micFilePath ? await readFile(captured.micFilePath) : null;
  const system = captured.systemFilePath ? await readFile(captured.systemFilePath) : null;
  const config = await loadAppConfig();
  const chunkSeconds = config.wavChunkSeconds > 0 ? config.wavChunkSeconds : 600;
  const durationSeconds = Number(captured.durationSeconds) || 0;
  const segmented = segmentTracks(mic, system, mix);
  // Quiet speech can fall below the segment peak floor; never seal with zero slices
  // when we still have a mix (spike path already does the same).
  const toUpload =
    segmented.length > 0
      ? segmented
      : mix.length > 44
        ? [
            {
              source: 'mix' as const,
              startSec: 0,
              endSec: durationSeconds,
              peak: 0,
              wav: mix,
            },
          ]
        : [];
  const files = captureFiles(captured);
  if (segmented.length === 0 && toUpload.length > 0) {
    logFrontend(`slices fallback mix sec=${durationSeconds.toFixed(1)}`);
  }
  const pieces = splitLongSegments(toUpload, chunkSeconds);
  if (pieces.length === 0) {
    return null;
  }
  return prepareBatch(nextSliceSeq, audioOffsetSec, durationSeconds, files, pieces);
}

async function exportLiveChunk(): Promise<void> {
  const noteId = uploadQueue.noteId;
  if (!noteId || capture.getState() === 'idle') return;
  if (uploadQueue.hasAudio) {
    await uploadQueue.drain(noteId);
    return;
  }
  const captured = await capture.exportChunk();
  if (!captured) return;
  logFrontend(`export chunk sec=${captured.durationSeconds.toFixed(1)}`);
  await uploadQueue.enqueue(noteId, captured);
  await uploadQueue.drain(noteId);
}

handleIpc('capture:arm', async (_event, noteId: string) => {
  assertCaptureAvailable();
  await resetExport();
  const config = await loadAppConfig();
  assertCaptureAvailable();
  await uploadQueue.arm(noteId, config.uploadRetrySeconds);
  exportTimer = setInterval(() => {
    exportChain = exportChain.then(() => exportLiveChunk()).catch((error: unknown) => {
      logFrontend(`export ${error instanceof Error ? error.message : 'failed'}`);
    });
  }, 10_000);
});
handleIpc('capture:disarm', async () => {
  assertCaptureAvailable();
  await resetExport();
});
handleIpc('capture:getState', () => capture.getState());
handleIpc('capture:finalizing', () => finalizingNoteId !== null);
handleIpc('capture:pending', () => uploadQueue.noteId
  ? { noteId: uploadQueue.noteId, typedNotes: uploadQueue.typedNotes }
  : null);

async function waitForNote(noteId: string, initial?: NoteRecord): Promise<NoteRecord> {
  const started = Date.now();
  let note = initial;
  while (Date.now() - started < 30 * 60 * 1000) {
    note = note ?? await notesApi.getNote(noteId);
    if (note.status === 'failed') throw new Error(note.errorMessage || 'slice_failed');
    if (note.status === 'ready') return note;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    note = undefined;
  }
  throw new Error('slice_timeout');
}

async function finishCapture(noteId: string, typedNotes: string): Promise<NoteRecord | undefined> {
  if (uploadQueue.noteId && uploadQueue.noteId !== noteId) throw new Error('capture_changed');
  stopExportTimer();
  await exportChain;
  if (capture.getState() === 'idle') {
    // Recovery and ambiguous HTTP responses must check persisted server state,
    // never call stop on an already stopped native recorder.
    const note = await notesApi.getNote(noteId);
    if (note.status === 'processing' || note.status === 'ready' || note.status === 'failed') {
      await resetExport(noteId);
      return note;
    }
  }
  if (uploadQueue.noteId !== noteId) throw new Error('capture_changed');
  await uploadQueue.setTypedNotes(noteId, typedNotes);
  if (capture.getState() !== 'idle') {
    try {
      await uploadQueue.enqueue(noteId, await capture.stop());
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const benign = message === 'empty' || message === 'too_short';
      if (!benign || (!uploadQueue.hasAudio && uploadQueue.nextSliceSeq === 1)) {
        if (benign) await resetExport(noteId);
        throw error;
      }
    }
  }
  try {
    await uploadQueue.drain(noteId);
  } catch (error) {
    logFrontend(`upload ${error instanceof Error ? error.message : 'failed'}`);
    throw new Error('upload_paused');
  }
  const durationSeconds = uploadQueue.durationSeconds;
  const config = await loadAppConfig();
  if (!Number.isFinite(durationSeconds) || durationSeconds < config.minListenSeconds) {
    await resetExport(noteId);
    throw new Error('too_short');
  }
  const finalSeq = uploadQueue.nextSliceSeq - 1;
  logFrontend(`capture stopped; finalSeq=${finalSeq} sec=${durationSeconds.toFixed(1)}`);
  let accepted: NoteRecord | undefined;
  try {
    await notesApi.sealNote(noteId, finalSeq, durationSeconds, typedNotes);
  } catch (error) {
    // The server may have committed before the response was lost. Keep local
    // progress if it cannot confirm acceptance, so Generate can safely retry.
    accepted = await notesApi.getNote(noteId).catch(() => undefined);
    if (!accepted || (accepted.status !== 'processing' && accepted.status !== 'ready' && accepted.status !== 'failed')) {
      throw error;
    }
  }
  await resetExport(noteId);
  return accepted;
}

handleIpc('debug:stopAndTranscribe', (_event, noteId: string, typedNotes: string) => {
  const existing = generations.get(noteId);
  if (existing) return existing;
  assertCaptureAvailable();
  finalizingNoteId = noteId;
  const generation = (async () => {
    let accepted: NoteRecord | undefined;
    try {
      accepted = await finishCapture(noteId, typedNotes ?? '');
    } finally {
      if (finalizingNoteId === noteId) finalizingNoteId = null;
    }
    // No capture or queue mutations after releasing the gate. Another note may
    // start while this one is being summarized on the server.
    return waitForNote(noteId, accepted);
  })().finally(() => { generations.delete(noteId); });
  generations.set(noteId, generation);
  return generation;
});
handleIpc('debug:hasLastMix', () => Boolean(lastMix && lastMix.length > 0));
handleIpc('debug:resend', async () => {
  if (!lastMix || lastMix.length === 0) {
    throw new Error('no_last_mix');
  }
  try {
    const transcript = await transcribeNote({ mix: lastMix, mic: lastMic, system: lastSystem });
    await saveDebugLog({
      segments: transcript.segments,
      backendLogs: transcript.logs,
    });
    return { text: transcript.text, language: transcript.language };
  } catch (error) {
    const failed = traceFailure(error);
    await saveDebugLog({
      segments: failed.segments,
      backendLogs: failed.logs,
      error: failed.message,
    });
    throw error;
  }
});

async function saveDebugLog(details: {
  durationSeconds?: number;
  segments: TraceSegment[];
  backendLogs: string[];
  error?: string;
}): Promise<void> {
  try {
    const file = await writeSessionTrace({
      inputName: lastInputName,
      systemAudioEnabled: lastSystemAudioEnabled,
      durationSeconds: details.durationSeconds,
      segments: details.segments,
      backendLogs: details.backendLogs,
      error: details.error,
    });
    logFrontend(`debug log ${file}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'debug_log_failed';
    logFrontend(`debug log failed ${message}`);
  }
}

function traceFailure(error: unknown): { message: string; segments: TraceSegment[]; logs: string[] } {
  const message = error instanceof Error ? error.message : 'transcribe_failed';
  const extra = error as { segments?: TraceSegment[]; logs?: string[] };
  return {
    message,
    segments: Array.isArray(extra.segments) ? extra.segments : [],
    logs: Array.isArray(extra.logs) ? extra.logs : [],
  };
}

async function openMicrophoneSettings(): Promise<void> {
  const url =
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone';
  await shell.openExternal(url);
  process.stderr.write('mic permission settings opened\n');
}

function installAppMenu(): void {
  // After ready. Building NSMenu before the app is ready traps on macOS (SIGTRAP).
  // Do not call app.setName: that renames the Keychain item.
  const appMenuName = 'Pith';
  app.setAboutPanelOptions({ applicationName: appMenuName });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: appMenuName,
        submenu: [
          { role: 'about', label: `About ${appMenuName}` },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${appMenuName}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${appMenuName}` },
        ],
      },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      { role: 'help', submenu: [] },
    ]),
  );
}

app.whenReady().then(async () => {
  await uploadQueue.restore();
  installAppMenu();
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'dock-icon.png'));
    if (!dockIcon.isEmpty() && app.dock) {
      app.dock.setIcon(dockIcon);
    }
    await systemPreferences.askForMediaAccess('microphone');
    await requestScreenCaptureAccess();
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  capture.dispose();
  lastMix = null;
  lastMic = null;
  lastSystem = null;
  app.quit();
});

app.on('before-quit', () => {
  stopExportTimer();
  uploadQueue.discardOnQuit();
  capture.dispose();
  lastMix = null;
  lastMic = null;
  lastSystem = null;
});

process.on('uncaughtException', (error) => {
  console.error(JSON.stringify({ event: 'uncaught', message: error.message }));
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : 'unhandled_rejection';
  console.error(JSON.stringify({ event: 'unhandled_rejection', message }));
});
