import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n/I18nProvider';
import { planLabel } from '../i18n/planLabel';

export function AccountPage() {
  const { t } = useI18n();
  const { signedIn, me, signIn, loading, refresh } = useAuth();
  const [params] = useSearchParams();
  const justPaid = params.get('checkout') === 'success';

  useEffect(() => {
    if (!justPaid) {
      return;
    }
    void refresh();
    const timer = window.setTimeout(() => {
      void refresh();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [justPaid, refresh]);

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
            <button type="button" onClick={() => void signIn()}>
              {t.signIn}
            </button>
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
          {t.signedInAs
            .replace('{email}', me.email)
            .replace('{plan}', planLabel(me, t))}
        </p>
      </section>
      <div className="grid pricing-grid">
        <article className="card">
          <h3>{t.remainingTitle}</h3>
          <p className="price">{t.remainingTime.replace('{minutes}', String(minutes))}</p>
          <p>{notesLine}</p>
        </article>
      </div>
      <p className="footer">{t.footerNote}</p>
    </div>
  );
}
