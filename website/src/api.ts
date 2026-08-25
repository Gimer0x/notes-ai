export type MeResponse = {
  id: string;
  email: string;
  displayName: string | null;
  plan: 'free' | 'paid';
  remainingSeconds: number;
  remainingNotes: number | null;
};

export function apiUrl(): string {
  return (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}
