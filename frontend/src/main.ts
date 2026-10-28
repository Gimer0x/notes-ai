import { app, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron';
import { readFile, unlink } from 'fs/promises';
import * as path from 'path';
import { AuthService } from './auth/auth.service';
import type { CaptureDevice, CaptureLevels } from './capture/capture.service';
import { segmentTracks, splitLongSegments } from './capture/segment-tracks';
import { requestScreenCaptureAccess } from './capture/helper-client';
import { NativeCaptureService } from './capture/native-capture.service';
import { backendUrl, captureSpikeKey, loadFrontendEnv, websiteUrl } from './env';
import { resetSessionTrace, trace, writeSessionTrace, type TraceSegment } from './debug/session-trace';
import { createAskApi } from './ask/ask-api';
import { createNotesApi } from './notes/notes-api';
import { SpikeClient, SpikeRequestError } from './spike/spike-client';
import en from './i18n/en.json';
import es from './i18n/es.json';

loadFrontendEnv();

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
  const response = await fetch(`${backendUrl().replace(/\/$/, '')}/config`);
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

ipcMain.handle('shell:openSpike', async (_event, workspaceId: string, workspaceName: string) => {
  const user = await signedInUser();
  if (!user) {
    throw new Error('sign_in_required');
  }
  beginNote();
  try {
    await capture.cancel();
  } catch {
    // Helper may not be running yet.
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
ipcMain.handle('shell:openNotepad', async () => {
  beginNote();
  try {
    await capture.cancel();
  } catch {
    // Helper may not be running yet.
  }
  if (mainWindow) {
    void mainWindow.loadFile(rendererFile('shell.html'));
  }
});
ipcMain.handle('shell:openSite', async (_event, page: string) => {
  if (page !== 'terms' && page !== 'privacy') {
    return;
  }
  await shell.openExternal(`${websiteUrl()}/${page}`);
});
ipcMain.handle('i18n:locale', () => preferredLocale());
ipcMain.handle('i18n:messages', (_event, locale: 'en' | 'es') => {
  return locale === 'es' ? es : en;
});
ipcMain.handle('config:get', () => loadAppConfig());
ipcMain.handle('auth:login', () => auth.login());
ipcMain.handle('auth:logout', () => auth.logout());
ipcMain.handle('auth:deleteAccount', async () => {
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
async function signedInUser(): Promise<unknown | null> {
  const token = await auth.getAccessToken();
  if (!token) {
    return null;
  }
  const response = await fetch(`${backendUrl()}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

ipcMain.handle('auth:me', () => signedInUser());
ipcMain.handle('billing:sync', async () => {
  const token = await auth.getAccessToken();
  if (!token) {
    return;
  }
  await fetch(`${backendUrl()}/billing/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
});
ipcMain.handle('billing:upgrade', async () => {
  await shell.openExternal(`${websiteUrl()}/pricing`);
});
ipcMain.handle('capture:preview', async () => {
  const result = await capture.preview();
  rememberSession(result);
  return result;
});
ipcMain.handle('capture:start', async () => {
  const result = await capture.start();
  rememberSession(result);
  return result;
});
ipcMain.handle('permissions:microphone', async () => {
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
ipcMain.handle('capture:pause', () => capture.pause());
ipcMain.handle('capture:resume', () => capture.resume());
ipcMain.handle('capture:cancel', async () => {
  beginNote();
  resetExport();
  await capture.cancel();
});
ipcMain.handle('capture:end', async () => {
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
ipcMain.handle('notes:listWorkspaces', () => notesApi.listWorkspaces());
ipcMain.handle('notes:createWorkspace', (_event, name: string) => notesApi.createWorkspace(name));
ipcMain.handle('notes:deleteWorkspace', (_event, id: string) => notesApi.deleteWorkspace(id));
ipcMain.handle('notes:setWorkspaceIcon', (_event, id: string, icon: string) =>
  notesApi.setWorkspaceIcon(id, icon),
);
ipcMain.handle('notes:listNotes', (_event, workspaceId: string) => notesApi.listNotes(workspaceId));
ipcMain.handle('notes:create', (_event, workspaceId: string, title: string | null) =>
  notesApi.createNote(workspaceId, title),
);
ipcMain.handle('notes:rename', (_event, id: string, title: string | null) =>
  notesApi.renameNote(id, title),
);
ipcMain.handle('notes:move', (_event, id: string, workspaceId: string) =>
  notesApi.moveNote(id, workspaceId),
);
ipcMain.handle('notes:delete', (_event, id: string) => notesApi.deleteNote(id));
ipcMain.handle('notes:cancel', (_event, id: string) => notesApi.cancelNote(id));
ipcMain.handle(
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
ipcMain.handle('notes:retry', (_event, id: string) => notesApi.retryNote(id));
ipcMain.handle('notes:share', (_event, id: string, emails: string[]) =>
  notesApi.shareNote(id, emails),
);
ipcMain.handle(
  'ask:send',
  (
    _event,
    messages: { role: 'user' | 'assistant'; text: string }[],
    attachments: { name: string; mime: string; dataBase64: string }[],
    noteId?: string | null,
  ) => askApi.send(messages, attachments, noteId),
);
ipcMain.handle(
  'ask:transcribe',
  (_event, dataBase64: string, mime: string, name: string) =>
    askApi.transcribe(dataBase64, mime, name),
);
let exportTimer: ReturnType<typeof setInterval> | null = null;
let armedNoteId: string | null = null;
let nextSliceSeq = 1;
let audioOffsetSec = 0;
let exportChain: Promise<void> = Promise.resolve();

function stopExportTimer(): void {
  if (exportTimer) {
    clearInterval(exportTimer);
    exportTimer = null;
  }
}

function resetExport(): void {
  stopExportTimer();
  armedNoteId = null;
  nextSliceSeq = 1;
  audioOffsetSec = 0;
}

async function uploadCaptured(
  noteId: string,
  captured: { filePath: string; durationSeconds: number; micFilePath?: string; systemFilePath?: string },
): Promise<void> {
  const mix = await readFile(captured.filePath);
  const mic = captured.micFilePath ? await readFile(captured.micFilePath) : null;
  const system = captured.systemFilePath ? await readFile(captured.systemFilePath) : null;
  await unlink(captured.filePath).catch(() => undefined);
  if (captured.micFilePath) {
    await unlink(captured.micFilePath).catch(() => undefined);
  }
  if (captured.systemFilePath) {
    await unlink(captured.systemFilePath).catch(() => undefined);
  }
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
  if (segmented.length === 0 && toUpload.length > 0) {
    logFrontend(`slices fallback mix sec=${durationSeconds.toFixed(1)}`);
  }
  const pieces = splitLongSegments(toUpload, chunkSeconds);
  const offset = audioOffsetSec;
  audioOffsetSec += durationSeconds;
  for (const piece of pieces) {
    const seq = nextSliceSeq;
    nextSliceSeq += 1;
    await notesApi.uploadSlice(
      noteId,
      seq,
      piece.source,
      offset + piece.startSec,
      offset + piece.endSec,
      piece.wav,
    );
  }
  logFrontend(`slices uploaded count=${pieces.length} next=${nextSliceSeq}`);
}

async function exportLiveChunk(): Promise<void> {
  const noteId = armedNoteId;
  if (!noteId || capture.getState() === 'idle') {
    return;
  }
  const captured = await capture.exportChunk();
  if (!captured) {
    return;
  }
  logFrontend(`export chunk sec=${captured.durationSeconds.toFixed(1)}`);
  await uploadCaptured(noteId, captured);
}

ipcMain.handle('capture:arm', (_event, noteId: string) => {
  resetExport();
  armedNoteId = noteId;
  exportTimer = setInterval(() => {
    exportChain = exportChain.then(() => exportLiveChunk()).catch((error: unknown) => {
      logFrontend(`export ${error instanceof Error ? error.message : 'failed'}`);
    });
  }, 10_000);
});
ipcMain.handle('capture:disarm', () => {
  resetExport();
});
ipcMain.handle('capture:getState', () => capture.getState());
ipcMain.handle('debug:stopAndTranscribe', async (_event, noteId: string, typedNotes: string) => {
  await exportChain;
  stopExportTimer();
  let tailSeconds = 0;
  try {
    const captured = await capture.stop();
    tailSeconds = Number(captured.durationSeconds) || 0;
    await uploadCaptured(noteId, captured);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if ((message !== 'empty' && message !== 'too_short') || nextSliceSeq === 1) {
      resetExport();
      throw error;
    }
  }
  const durationSeconds = audioOffsetSec;
  const config = await loadAppConfig();
  if (!Number.isFinite(durationSeconds) || durationSeconds < config.minListenSeconds) {
    resetExport();
    throw new Error('too_short');
  }
  const finalSeq = nextSliceSeq - 1;
  logFrontend(`capture stopped; finalSeq=${finalSeq} sec=${durationSeconds.toFixed(1)} tail=${tailSeconds.toFixed(1)}`);
  await notesApi.sealNote(noteId, finalSeq, durationSeconds, typedNotes ?? '');
  resetExport();
  const started = Date.now();
  while (Date.now() - started < 30 * 60 * 1000) {
    const note = await notesApi.getNote(noteId);
    if (note.status === 'ready' || note.status === 'failed') {
      if (note.status === 'failed') {
        throw new Error(note.errorMessage || 'slice_failed');
      }
      return note;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('slice_timeout');
});
ipcMain.handle('debug:hasLastMix', () => Boolean(lastMix && lastMix.length > 0));
ipcMain.handle('debug:resend', async () => {
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

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
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
  capture.dispose();
  lastMix = null;
  lastMic = null;
  lastSystem = null;
});

process.on('unhandledRejection', (reason) => {
  console.error(reason);
});
