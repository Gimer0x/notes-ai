import { useI18n } from '../i18n/I18nProvider';

export function HomePage() {
  const { t } = useI18n();

  return (
    <>
      <section className="hero wrap">
        <div className="hero-copy">
          <span className="badge">{t.heroBadge}</span>
          <h1>{t.heroTitle}</h1>
          <p className="hero-sub">{t.heroSub}</p>
          <div className="actions">
            <button type="button" disabled title={t.downloadSoon}>
              {t.downloadMac}
            </button>
          </div>
          <p className="os-line">{t.availableMac}</p>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="collage-wash" />
          <div className="collage-accent" />
          <article className="note-window">
            <div className="note-dots">
              <span />
              <span />
              <span />
            </div>
            <h2>{t.mockTitle}</h2>
            <ol>
              <li>{t.mockLine1}</li>
              <li>{t.mockLine2}</li>
              <li>{t.mockLine3}</li>
            </ol>
            <p className="caption">{t.mockCaption}</p>
          </article>
        </div>
      </section>

      <section className="section wrap">
        <h2>{t.howTitle}</h2>
        <div className="grid">
          <article className="card">
            <span className="index">01</span>
            <h3>{t.howMicTitle}</h3>
            <p>{t.howMic}</p>
          </article>
          <article className="card">
            <span className="index">02</span>
            <h3>{t.howSystemTitle}</h3>
            <p>{t.howSystem}</p>
          </article>
          <article className="card">
            <span className="index">03</span>
            <h3>{t.howMixTitle}</h3>
            <p>{t.howMix}</p>
          </article>
        </div>
      </section>

      <p className="footer wrap">{t.footerNote}</p>
    </>
  );
}
