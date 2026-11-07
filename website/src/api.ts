export type MeResponse = {
  id: string;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
  remainingSeconds: number;
  remainingNotes: number | null;
  accessUntil: string | null;
  billingPaused: boolean;
  freeEligibleAt?: string | null;
};

export function apiUrl(): string {
  return (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    credentials: 'include',
    signal: init.signal ?? AbortSignal.timeout(20_000),
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}
