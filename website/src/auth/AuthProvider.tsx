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
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const response = await apiFetch('/me');
    if (!response.ok) {
      setMe(null);
      return;
    }
    setMe((await response.json()) as MeResponse);
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const signIn = useCallback(async () => {
    await startGoogleLogin();
  }, []);

  const signOut = useCallback(async () => {
    await apiFetch('/auth/logout', { method: 'POST' });
    setMe(null);
  }, []);

  const value = useMemo(
    () => ({
      signedIn: Boolean(me),
      me,
      loading,
      signIn,
      signOut,
      refresh,
    }),
    [me, loading, signIn, signOut, refresh],
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
