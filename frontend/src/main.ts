import { app, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron';
import { readFile, unlink } from 'fs/promises';
import * as path from 'path';
import { AuthService } from './auth/auth.service';
import type { CaptureDevice, CaptureLevels } from './capture/capture.service';
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
let lastSystemAudioEnabled = false;

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
  const window = new BrowserWindow({
    width: 880,
    height: 720,
    title: 'Pith Capture Spike',
    backgroundColor: '#F7F4EE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void window.loadFile(path.join(__dirname, 'renderer/index.html'));
}

ipcMain.handle('i18n:locale', () => preferredLocale());
ipcMain.handle('i18n:messages', (_event, locale: 'en' | 'es') => {
  return locale === 'es' ? es : en;
});
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
  lastSystemAudioEnabled = result.systemAudioEnabled;
  return result;
});
ipcMain.handle('capture:start', async () => {
  const result = await capture.start();
  lastSystemAudioEnabled = result.systemAudioEnabled;
  return result;
});
ipcMain.handle('capture:pause', () => capture.pause());
ipcMain.handle('capture:resume', () => capture.resume());
ipcMain.handle('capture:cancel', () => capture.cancel());
ipcMain.handle('capture:getState', () => capture.getState());
ipcMain.handle('debug:stopAndTranscribe', async () => {
  const captured = await capture.stop();
  const wav = await readFile(captured.filePath);
  await unlink(captured.filePath);
  lastMix = wav;
  const transcript = await spike.transcribe(wav);
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
  return spike.transcribe(lastMix);
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
  app.quit();
});

app.on('before-quit', () => {
  capture.dispose();
  lastMix = null;
});

process.on('unhandledRejection', (reason) => {
  console.error(reason);
});
