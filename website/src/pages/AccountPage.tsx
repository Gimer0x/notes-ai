import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n/I18nProvider';
import { planLabel } from '../i18n/planLabel';

function accessDay(iso: string | null | undefined, locale: string): string {
  if (!iso) {
    return '';
  }
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) {
    return '';
  }
  const lastInstant = new Date(end.getTime() - 1);
  return lastInstant.toLocaleDateString(locale === 'es' ? 'es' : 'en', { dateStyle: 'long' });
}

function renewalDay(iso: string | null | undefined, locale: string): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString(locale === 'es' ? 'es' : 'en', { dateStyle: 'long' });
}

export function AccountPage() {
  const { locale, t } = useI18n();
  const { signedIn, me, loading, refresh, signOut } = useAuth();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteWord, setDeleteWord] = useState('');
  const [working, setWorking] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [params] = useSearchParams();
  const justPaid = params.get('checkout') === 'success';
  const sessionId = params.get('session_id');

  useEffect(() => {
    if (!justPaid || !signedIn) {
      return;
    }
    let stopped = false;
    async function pull(): Promise<void> {
      try {
        const response = await apiFetch('/billing/sync', {
          method: 'POST',
          body: JSON.stringify(sessionId ? { sessionId } : {}),
        });
        if (!stopped && response.ok) {
          await refresh();
        }
      } catch {
        // Keep the account already on screen.
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
          {me.freeEligibleAt ? (
            <p>{t.freeEligible.replace('{date}', renewalDay(me.freeEligibleAt, locale))}</p>
          ) : null}
        </article>
      </div>
      )}
      <div className="account-actions">
        {me.plan === 'paid' ? (
          <article className="card">
            <h3>{t.pauseAccount}</h3>
            <p>
              {me.accessUntil
                ? t.pauseAccountHint.replace('{date}', accessDay(me.accessUntil, locale))
                : t.pauseAccountHintOpen}
            </p>
            {me.billingPaused ? (
              <>
                <p>{t.pauseAccountUntil.replace('{date}', accessDay(me.accessUntil, locale))}</p>
                {resumeOpen ? (
                  <p>
                    {me.accessUntil
                      ? t.resumeAccountBody.replace('{date}', renewalDay(me.accessUntil, locale))
                      : t.resumeAccountBodyOpen}
                  </p>
                ) : null}
                {resumeOpen ? (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => {
                      void (async () => {
                        setWorking(true);
                        setAccountError('');
                        try {
                          const response = await apiFetch('/me/resume', {
                            method: 'POST',
                            body: JSON.stringify({ confirm: 'RESUME' }),
                          });
                          if (!response.ok) {
                            setAccountError(t.accountActionFailed);
                            return;
                          }
                          setResumeOpen(false);
                          await refresh();
                        } catch {
                          setAccountError(t.accountActionFailed);
                        } finally {
                          setWorking(false);
                        }
                      })();
                    }}
                  >
                    {t.resumeAccountConfirm}
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={() => setResumeOpen(true)}>
                    {t.resumeAccount}
                  </button>
                )}
              </>
            ) : (
              <>
                {pauseOpen ? (
                  <p>
                    {me.accessUntil
                      ? t.pauseAccountBody.replace('{date}', accessDay(me.accessUntil, locale))
                      : t.pauseAccountBodyOpen}
                  </p>
                ) : null}
                {pauseOpen ? (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => {
                      void (async () => {
                        setWorking(true);
                        setAccountError('');
                        try {
                          const response = await apiFetch('/me/pause', {
                            method: 'POST',
                            body: JSON.stringify({ confirm: 'PAUSE' }),
                          });
                          if (!response.ok) {
                            setAccountError(t.accountActionFailed);
                            return;
                          }
                          setPauseOpen(false);
                          await refresh();
                        } catch {
                          setAccountError(t.accountActionFailed);
                        } finally {
                          setWorking(false);
                        }
                      })();
                    }}
                  >
                    {t.pauseAccountConfirm}
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={() => setPauseOpen(true)}>
                    {t.pauseAccount}
                  </button>
                )}
              </>
            )}
          </article>
        ) : null}
        <article className="card">
          <h3>{t.deleteAccount}</h3>
          <p>{t.deleteAccountHint}</p>
          {deleteOpen ? (
            <>
              <p>{t.deleteAccountBody}</p>
              <input
                value={deleteWord}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDeleteWord(event.target.value)}
              />
              <button
                type="button"
                disabled={working || deleteWord !== 'DELETE'}
                onClick={() => {
                  void (async () => {
                    setWorking(true);
                    setAccountError('');
                    try {
                      const response = await apiFetch('/me', {
                        method: 'DELETE',
                        body: JSON.stringify({ confirm: 'DELETE' }),
                      });
                      if (!response.ok) {
                        setAccountError(t.accountActionFailed);
                        return;
                      }
                      await signOut();
                    } catch {
                      setAccountError(t.accountActionFailed);
                    } finally {
                      setWorking(false);
                    }
                  })();
                }}
              >
                {t.deleteAccountConfirm}
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={() => setDeleteOpen(true)}>
              {t.deleteAccount}
            </button>
          )}
        </article>
        {accountError ? <p>{accountError}</p> : null}
      </div>
      <p className="footer">{t.footerNote}</p>
    </div>
  );
}
