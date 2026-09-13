import { app, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron';
import { readFile, unlink } from 'fs/promises';
import * as path from 'path';
import { AuthService } from './auth/auth.service';
import type { CaptureDevice, CaptureLevels } from './capture/capture.service';
import { segmentTracks } from './capture/segment-tracks';
import { NativeCaptureService } from './capture/native-capture.service';
import { backendUrl, captureSpikeKey, loadFrontendEnv, websiteUrl } from './env';
import { SpikeClient } from './spike/spike-client';
import en from './i18n/en.json';
import es from './i18n/es.json';

loadFrontendEnv();

const capture = new NativeCaptureService();
const spike = new SpikeClient(backendUrl(), captureSpikeKey());
const auth = new AuthService();
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
}

let lastLoggedMinListen: number | undefined;

async function loadAppConfig(): Promise<{ minListenSeconds: number }> {
  const response = await fetch(`${backendUrl().replace(/\/$/, '')}/config`);
  if (!response.ok) {
    throw new Error('config_failed');
  }
  const body = (await response.json()) as { minListenSeconds?: number };
  const minListenSeconds = Number(body.minListenSeconds);
  if (!Number.isFinite(minListenSeconds) || minListenSeconds <= 0) {
    throw new Error('config_failed');
  }
  if (lastLoggedMinListen !== minListenSeconds) {
    lastLoggedMinListen = minListenSeconds;
    process.stderr.write(`config minListenSeconds=${minListenSeconds}\n`);
  }
  return { minListenSeconds };
}

function previewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function transcribeNote(files: {
  mix: Buffer;
  mic: Buffer | null;
  system: Buffer | null;
}): Promise<{ text: string; language: 'en' | 'es' }> {
  const started = Date.now();
  const segments = segmentTracks(files.mic, files.system, files.mix);
  process.stderr.write(`spike segments=${segments.length}\n`);
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
  let language: 'en' | 'es' = 'en';
  for (const [index, segment] of toSend.entries()) {
    process.stderr.write(
      `spike segment ${index} ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}s source=${segment.source} peak=${segment.peak} bytes=${segment.wav.length}\n`,
    );
    const result = await spike.transcribe(segment.wav, `${segment.source}-${index}.wav`);
    process.stderr.write(
      `spike segment ${index} lang=${result.language} chars=${result.text.length} preview=${previewText(result.text)}\n`,
    );
    if (result.text.trim()) {
      texts.push(result.text.trim());
      language = result.language;
    }
  }
  process.stderr.write(
    `spike done segments=${toSend.length} chars=${texts.join('\n\n').length} ms=${Date.now() - started}\n`,
  );
  return { text: texts.join('\n\n').trim(), language };
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
    width: 960,
    height: 700,
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

ipcMain.handle('shell:openSpike', async () => {
  beginNote();
  try {
    await capture.cancel();
  } catch {
    // Helper may not be running yet.
  }
  if (mainWindow) {
    void mainWindow.loadFile(rendererFile('index.html'), {
      query: { note: String(Date.now()) },
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
ipcMain.handle('i18n:locale', () => preferredLocale());
ipcMain.handle('i18n:messages', (_event, locale: 'en' | 'es') => {
  return locale === 'es' ? es : en;
});
ipcMain.handle('config:get', () => loadAppConfig());
ipcMain.handle('auth:login', () => auth.login());
ipcMain.handle('auth:logout', () => auth.logout());
ipcMain.handle('auth:me', async () => {
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
ipcMain.handle('capture:pause', () => capture.pause());
ipcMain.handle('capture:resume', () => capture.resume());
ipcMain.handle('capture:cancel', async () => {
  beginNote();
  await capture.cancel();
});
ipcMain.handle('capture:getState', () => capture.getState());
ipcMain.handle('debug:stopAndTranscribe', async () => {
  const captured = await capture.stop();
  const mix = await readFile(captured.filePath);
  const mic = captured.micFilePath ? await readFile(captured.micFilePath) : null;
  const system = captured.systemFilePath
    ? await readFile(captured.systemFilePath)
    : null;
  await unlink(captured.filePath);
  if (captured.micFilePath) {
    await unlink(captured.micFilePath).catch(() => undefined);
  }
  if (captured.systemFilePath) {
    await unlink(captured.systemFilePath).catch(() => undefined);
  }
  const durationSeconds = Number(captured.durationSeconds);
  process.stderr.write(
    `spike files mix=${mix.length}B mic=${mic?.length ?? 0}B sys=${system?.length ?? 0}B duration=${Number.isFinite(durationSeconds) ? durationSeconds.toFixed(2) : 'invalid'}s\n`,
  );
  const { minListenSeconds } = await loadAppConfig();
  if (!Number.isFinite(durationSeconds) || durationSeconds < minListenSeconds) {
    process.stderr.write(
      `spike too_short duration=${Number.isFinite(durationSeconds) ? durationSeconds.toFixed(2) : 'invalid'}s min=${minListenSeconds}\n`,
    );
    lastMix = null;
    lastMic = null;
    lastSystem = null;
    throw new Error('too_short');
  }
  lastMix = mix;
  lastMic = mic;
  lastSystem = system;
  const transcript = await transcribeNote({ mix, mic, system });
  return {
    ...transcript,
    durationSeconds: captured.durationSeconds,
    systemAudioEnabled: lastSystemAudioEnabled,
  };
});
ipcMain.handle('debug:hasLastMix', () => Boolean(lastMix && lastMix.length > 0));
ipcMain.handle('debug:resend', async () => {
  if (!lastMix || lastMix.length === 0) {
    throw new Error('no_last_mix');
  }
  return transcribeNote({ mix: lastMix, mic: lastMic, system: lastSystem });
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
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
