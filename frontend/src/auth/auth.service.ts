import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFile, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { backendUrl, googleDesktopClientId } from '../env';

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

export class AuthService {
  async login(): Promise<void> {
    const clientId = googleDesktopClientId();
    if (!clientId) {
      throw new Error('no_google_client');
    }
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const state = base64Url(randomBytes(16));
    const loopback = await startLoopback(state);
    const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    await shell.openExternal(url.toString());
    try {
      const code = await loopback.waitForCode();
      const response = await fetch(`${backendUrl()}/auth/electron/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          codeVerifier: verifier,
          redirectUri,
        }),
      });
      const payload = (await response.json()) as {
        accessToken?: string;
        message?: string;
      };
      if (!response.ok || !payload.accessToken) {
        loopback.finish(false);
        throw new Error(payload.message || 'auth_failed');
      }
      await this.storeToken(payload.accessToken);
      loopback.finish(true);
      focusPithWindows();
    } catch (error) {
      loopback.finish(false);
      throw error;
    }
  }

  async logout(): Promise<void> {
    try {
      await unlink(tokenPath());
    } catch {
      // Already signed out.
    }
  }

  async getAccessToken(): Promise<string | null> {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return null;
      }
      const encrypted = await readFile(tokenPath());
      const token = safeStorage.decryptString(encrypted);
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  private async storeToken(token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safe_storage_unavailable');
    }
    await writeFile(tokenPath(), safeStorage.encryptString(token));
  }
}

function tokenPath(): string {
  return path.join(app.getPath('userData'), 'pith-access-token');
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

async function startLoopback(expectedState: string): Promise<{
  port: number;
  waitForCode: () => Promise<string>;
  finish: (ok: boolean) => void;
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  let pendingRes: ServerResponse | null = null;
  let finished = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const finish = (ok: boolean): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (pendingRes && !pendingRes.writableEnded) {
      pendingRes.statusCode = ok ? 200 : 400;
      pendingRes.setHeader('Content-Type', 'text/html; charset=utf-8');
      pendingRes.end(closePage(ok));
    }
    server.close();
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = `http://127.0.0.1:${addressPort(server)}`;
    const url = new URL(req.url ?? '/', host);
    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (error || state !== expectedState || !code) {
      pendingRes = res;
      finish(false);
      rejectCode(new Error(error || 'auth_denied'));
      return;
    }
    pendingRes = res;
    resolveCode(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('auth_loopback_failed');
  }
  const timeout = setTimeout(() => {
    finish(false);
    rejectCode!(new Error('auth_timeout'));
  }, LOGIN_TIMEOUT_MS);
  void codePromise.finally(() => clearTimeout(timeout));
  return {
    port: addr.port,
    waitForCode: () => codePromise,
    finish,
  };
}

function focusPithWindows(): void {
  app.focus({ steal: true });
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational');
  }
}

function addressPort(server: ReturnType<typeof createServer>): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    return 0;
  }
  return addr.port;
}

function closePage(ok: boolean): string {
  const styles = `body{font-family:system-ui,sans-serif;background:#FAF7F1;color:#1c1c19;max-width:36rem;margin:4rem auto;padding:0 1.5rem;line-height:1.45}h1{font-size:1.35rem;font-weight:650}p{color:#5c5c56}`;
  if (ok) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Pith</title><style>${styles}</style></head><body>
      <h1>You're signed in to the Mac app</h1>
      <p>Switch back to Pith to see your email and plan. You can close this tab.</p>
      <h1>Sesión iniciada en la app de Mac</h1>
      <p>Vuelve a Pith para ver tu correo y el plan. Puedes cerrar esta pestaña.</p>
      <script>setTimeout(() => window.close(), 600);</script>
    </body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pith</title><style>${styles}</style></head><body>
    <h1>Sign-in did not finish</h1>
    <p>Return to the Mac app and try again. You can close this tab.</p>
    <h1>No se pudo iniciar sesión</h1>
    <p>Vuelve a la app de Mac e inténtalo de nuevo. Puedes cerrar esta pestaña.</p>
    <script>setTimeout(() => window.close(), 600);</script>
  </body></html>`;
}
