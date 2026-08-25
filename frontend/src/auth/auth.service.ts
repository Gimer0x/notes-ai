import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFile, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { app, safeStorage, shell } from 'electron';
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
      throw new Error(payload.message || 'auth_failed');
    }
    await this.storeToken(payload.accessToken);
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
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
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
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(closePage(false));
      rejectCode(new Error(error || 'auth_denied'));
      server.close();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(closePage(true));
    resolveCode(code);
    server.close();
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
    server.close();
    rejectCode!(new Error('auth_timeout'));
  }, LOGIN_TIMEOUT_MS);
  void codePromise.finally(() => clearTimeout(timeout));
  return {
    port: addr.port,
    waitForCode: () => codePromise,
  };
}

function addressPort(server: ReturnType<typeof createServer>): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    return 0;
  }
  return addr.port;
}

function closePage(ok: boolean): string {
  if (ok) {
    return `<!doctype html><meta charset="utf-8"><title>Pith</title>
      <p>Signed in. You can close this tab.</p>
      <p>Sesión iniciada. Puedes cerrar esta pestaña.</p>`;
  }
  return `<!doctype html><meta charset="utf-8"><title>Pith</title>
    <p>Sign-in did not finish. You can close this tab.</p>
    <p>No se pudo iniciar sesión. Puedes cerrar esta pestaña.</p>`;
}
