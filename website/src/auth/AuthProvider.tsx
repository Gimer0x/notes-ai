import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch, type MeResponse } from '../api';
import { startGoogleLogin } from './google';

type AuthValue = {
  signedIn: boolean;
  me: MeResponse | null;
  loading: boolean;
  unavailable: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch('/me');
      if (response.status === 401) {
        setMe(null);
        setUnavailable(false);
        return;
      }
      if (!response.ok) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setMe((await response.json()) as MeResponse);
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const signIn = useCallback(async () => {
    try {
      await startGoogleLogin();
    } catch {
      setUnavailable(true);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      const response = await apiFetch('/auth/logout', { method: 'POST' });
      if (!response.ok) {
        setUnavailable(true);
      } else {
        setUnavailable(false);
      }
    } catch {
      setUnavailable(true);
    }
    setMe(null);
  }, []);

  const value = useMemo(
    () => ({
      signedIn: Boolean(me),
      me,
      loading,
      unavailable,
      signIn,
      signOut,
      refresh,
    }),
    [me, loading, unavailable, signIn, signOut, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
