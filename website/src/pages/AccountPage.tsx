import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n/I18nProvider';
import { planLabel } from '../i18n/planLabel';

export function AccountPage() {
  const { t } = useI18n();
  const { signedIn, me, loading, refresh } = useAuth();
  const [params] = useSearchParams();
  const justPaid = params.get('checkout') === 'success';
  const sessionId = params.get('session_id');

  useEffect(() => {
    if (!justPaid || !signedIn) {
      return;
    }
    let stopped = false;
    async function pull(): Promise<void> {
      await apiFetch('/billing/sync', {
        method: 'POST',
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      }).catch(() => undefined);
      if (!stopped) {
        await refresh();
      }
    }
    void pull();
    const timers = [1500, 4000].map((delay) =>
      window.setTimeout(() => {
        void pull();
      }, delay),
    );
    return () => {
      stopped = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [justPaid, signedIn, refresh, sessionId]);

  if (loading) {
    return (
      <div className="wrap">
        <section className="pricing-hero">
          <p className="lead">{t.authWorking}</p>
        </section>
      </div>
    );
  }

  if (!signedIn || !me) {
    return (
      <div className="wrap">
        <section className="pricing-hero">
          <h1>{t.navAccount}</h1>
          <p className="lead">{t.accountSignIn}</p>
          <div className="actions">
            <Link className="button-link" to="/welcome">
              {t.signIn}
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const minutes = Math.floor(me.remainingSeconds / 60);
  const notesLine =
    me.remainingNotes === null
      ? t.remainingNotesUnlimited
      : t.remainingNotesCount.replace('{count}', String(me.remainingNotes));

  return (
    <div className="wrap">
      <section className="pricing-hero">
        <h1>{justPaid ? t.paidSuccessTitle : t.navAccount}</h1>
        {justPaid ? <p className="lead">{t.paidSuccessBody}</p> : null}
        <p className="lead">
          {justPaid && me.plan !== 'paid'
            ? t.paidSuccessPending
            : t.signedInAs
                .replace('{email}', me.email)
                .replace('{plan}', planLabel(me, t))}
        </p>
      </section>
      {justPaid && me.plan !== 'paid' ? null : (
      <div className="grid pricing-grid">
        <article className="card">
          <h3>{t.remainingTitle}</h3>
          <p className="price">{t.remainingTime.replace('{minutes}', String(minutes))}</p>
          <p>{notesLine}</p>
        </article>
      </div>
      )}
      <p className="footer">{t.footerNote}</p>
    </div>
  );
}
