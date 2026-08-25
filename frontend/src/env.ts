import * as path from 'path';
import * as dotenv from 'dotenv';

export function loadFrontendEnv(): void {
  dotenv.config({ path: path.join(__dirname, '../.env') });
}

export function backendUrl(): string {
  return process.env.BACKEND_URL?.trim() || 'http://localhost:3000';
}

export function captureSpikeKey(): string {
  return process.env.CAPTURE_SPIKE_KEY?.trim() || '';
}

export function googleDesktopClientId(): string {
  return process.env.GOOGLE_DESKTOP_CLIENT_ID?.trim() || '';
}
