import { useState } from 'react';
import { apiFetch } from '../api';
import { useAuth } from '../auth/AuthProvider';
import { formatAmount } from '../i18n/locale';
import { planLabel } from '../i18n/planLabel';
import { useI18n } from '../i18n/I18nProvider';

export function PricingPage() {
  const { t } = useI18n();
  const { signedIn, me, signIn, refresh } = useAuth();
  const monthly = import.meta.env.VITE_PRICE_MONTHLY_USD ?? '—';
  const yearly = import.meta.env.VITE_PRICE_YEARLY_USD ?? '—';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const paid = me?.plan === 'paid';
  const paidLabel = me ? planLabel(me, t) : t.planPaid;
  const alreadyOnPlan = t.alreadyPaid.replace('{plan}', paidLabel);

  async function startCheckout(interval: 'month' | 'year'): Promise<void> {
    if (!signedIn) {
      await signIn();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/billing/checkout-session', {
        method: 'POST',
        body: JSON.stringify({ interval }),
      });
      const payload = (await response.json()) as { url?: string; message?: string };
      if (response.status === 409) {
        setError(t.alreadyPaid.replace('{plan}', paidLabel));
        await refresh();
        setBusy(false);
        return;
      }
      if (!response.ok || !payload.url) {
        throw new Error(payload.message || 'checkout_failed');
      }
      window.location.assign(payload.url);
    } catch {
      setError(t.checkoutError);
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <section className="pricing-hero">
        <h1>{t.pricingTitle}</h1>
        <p className="lead">{t.pricingLead}</p>
      </section>

      <div className="grid pricing-grid">
        <article className="card">
          <h3>{t.planFree}</h3>
          <p>{t.freeCap}</p>
          <div className="actions">
            <button type="button" className="secondary" disabled title={t.downloadSoon}>
              {t.downloadMac}
            </button>
          </div>
        </article>
        <article className="card featured">
          <h3>{t.planPaid}</h3>
          <p>{t.paidCap}</p>
          <p className="price">{formatAmount(t.priceMonthly, monthly)}</p>
          <p className="price">{formatAmount(t.priceYearly, yearly)}</p>
          <div className="actions">
            <button
              type="button"
              disabled={busy || paid}
              title={paid ? alreadyOnPlan : undefined}
              onClick={() => void startCheckout('month')}
            >
              {t.chooseMonthly}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || paid}
              title={paid ? alreadyOnPlan : undefined}
              onClick={() => void startCheckout('year')}
            >
              {t.chooseYearly}
            </button>
          </div>
        </article>
      </div>

      {paid ? <p className="hint">{alreadyOnPlan}</p> : <p className="hint">{t.checkoutHint}</p>}
      {error ? <p className="hint">{error}</p> : null}
      <p className="footer">{t.footerNote}</p>
    </div>
  );
}
