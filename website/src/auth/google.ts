const STATE_KEY = 'pith.oauth.state';
const VERIFIER_KEY = 'pith.oauth.verifier';

function randomUrlSafe(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let binary = '';
  arr.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = '';
  bytes.forEach((item) => {
    binary += String.fromCharCode(item);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function googleRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

export async function startGoogleLogin(): Promise<void> {
  const clientId = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID?.trim() ?? '';
  if (!clientId) {
    throw new Error('no_google_client');
  }
  const state = randomUrlSafe(16);
  const verifier = randomUrlSafe(32);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await sha256Base64Url(verifier);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', googleRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  window.location.assign(url.toString());
}

export function takeOauthCallback(search: string): {
  code: string;
  codeVerifier: string;
} {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  if (error) {
    throw new Error(error);
  }
  const state = params.get('state') ?? '';
  const expected = sessionStorage.getItem(STATE_KEY) ?? '';
  const verifier = sessionStorage.getItem(VERIFIER_KEY) ?? '';
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  const code = params.get('code') ?? '';
  if (!code || !verifier || state !== expected) {
    throw new Error('auth_denied');
  }
  return { code, codeVerifier: verifier };
}
