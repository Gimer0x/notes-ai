import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFile, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { backendUrl, googleDesktopClientId, websiteUrl } from '../env';

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
  let pageLang: 'en' | 'es' = 'en';
  const finish = (ok: boolean): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (pendingRes && !pendingRes.writableEnded) {
      pendingRes.statusCode = ok ? 200 : 400;
      pendingRes.setHeader('Content-Type', 'text/html; charset=utf-8');
      pendingRes.end(closePage(ok, pageLang));
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
    const header = req.headers['accept-language'];
    const accept = Array.isArray(header) ? header.join(',') : header ?? '';
    pageLang = accept.toLowerCase().includes('es') ? 'es' : 'en';
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

function closePage(ok: boolean, lang: 'en' | 'es'): string {
  const site = escapeHtml(websiteUrl());
  const copy =
    lang === 'es'
      ? ok
        ? {
            title: 'Abriendo Pith...',
            lead: 'Pith debería pasar al frente. Puedes cerrar esta pestaña.',
            fallback: `¿No pasó nada? Vuelve a la ventana de Pith, o si nunca la has abierto <a href="${site}">descárgala aquí</a>.`,
          }
        : {
            title: 'No se pudo iniciar sesión',
            lead: 'Vuelve a la app de Mac e inténtalo de nuevo.',
            fallback: 'Puedes cerrar esta pestaña.',
          }
      : ok
        ? {
            title: 'Opening Pith...',
            lead: 'Pith should come to the front. You can close this tab.',
            fallback: `Nothing happened? Switch back to the Pith window, or if you have never opened it <a href="${site}">download it here</a>.`,
          }
        : {
            title: 'Sign-in did not finish',
            lead: 'Return to the Mac app and try again.',
            fallback: 'You can close this tab.',
          };
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${copy.title}</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      background: #f6f4ef;
      color: #2a2e3c;
      font-family: "Iowan Old Style", Palatino, Georgia, serif;
      text-align: center;
      padding: 32px 20px;
    }
    main { max-width: 40rem; }
    .check {
      width: 54px;
      height: 54px;
      margin: 0 auto 28px;
      border-radius: 50%;
      background: #2537d5;
      display: grid;
      place-items: center;
    }
    .check span {
      width: 14px;
      height: 8px;
      border-left: 3px solid #fff;
      border-bottom: 3px solid #fff;
      transform: rotate(-45deg) translate(1px, -1px);
    }
    h1 {
      margin: 0 0 22px;
      font-size: clamp(2.6rem, 6vw, 4.2rem);
      font-weight: 500;
      letter-spacing: -0.03em;
    }
    p {
      margin: 0 auto 18px;
      max-width: 34rem;
      color: #8a8278;
      font-family: "Source Sans 3", ui-sans-serif, system-ui, sans-serif;
      font-size: 1.2rem;
      line-height: 1.45;
    }
    a { color: #5c6570; }
  </style>
</head>
<body>
  <main>
    <div class="check" aria-hidden="true"><span></span></div>
    <h1>${copy.title}</h1>
    <p>${copy.lead}</p>
    <p>${copy.fallback}</p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
