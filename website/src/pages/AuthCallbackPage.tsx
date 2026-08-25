import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { googleRedirectUri, takeOauthCallback } from '../auth/google';
import { useI18n } from '../i18n/I18nProvider';

let exchangeStarted = false;

export function AuthCallbackPage() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    if (exchangeStarted) {
      return;
    }
    exchangeStarted = true;
    void (async () => {
      try {
        const { code, codeVerifier } = takeOauthCallback(window.location.search);
        const response = await apiFetch('/auth/web/callback', {
          method: 'POST',
          body: JSON.stringify({
            code,
            codeVerifier,
            redirectUri: googleRedirectUri(),
          }),
        });
        if (!response.ok) {
          throw new Error('auth_failed');
        }
        await refresh();
        navigate('/', { replace: true });
      } catch {
        exchangeStarted = false;
        setError(t.authError);
      }
    })();
  }, [navigate, refresh, t.authError]);

  if (error) {
    return (
      <main className="wrap">
        <section className="pricing-hero">
          <h1>{t.authError}</h1>
          <p className="lead">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="wrap">
      <section className="pricing-hero">
        <p className="lead">{t.authWorking}</p>
      </section>
    </main>
  );
}
