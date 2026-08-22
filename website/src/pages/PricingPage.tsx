import { formatAmount } from '../i18n/locale';
import { useI18n } from '../i18n/I18nProvider';

export function PricingPage() {
  const { t } = useI18n();
  const monthly = import.meta.env.VITE_PRICE_MONTHLY_USD ?? '—';
  const yearly = import.meta.env.VITE_PRICE_YEARLY_USD ?? '—';

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
            <button type="button" disabled title={t.checkoutLater}>
              {t.chooseMonthly}
            </button>
            <button type="button" className="secondary" disabled title={t.checkoutLater}>
              {t.chooseYearly}
            </button>
          </div>
        </article>
      </div>

      <p className="hint">{t.checkoutLater}</p>
      <p className="footer">{t.footerNote}</p>
    </div>
  );
}
