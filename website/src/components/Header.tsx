import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n/I18nProvider';

export function Header() {
  const { t } = useI18n();
  const { signedIn, signIn, signOut } = useAuth();

  return (
    <header className="header">
      <div className="wrap header-inner">
        <NavLink to="/" className="brand">
          <img src="/pith-mark.png" alt={t.appName} />
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            {t.navHome}
          </NavLink>
          <NavLink to="/pricing">{t.navPricing}</NavLink>
          {signedIn ? (
            <>
              <span className="status">{t.signedInAs}</span>
              <button type="button" className="secondary" onClick={signOut}>
                {t.signOut}
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={signIn} title={t.authPreviewHint}>
              {t.signIn}
            </button>
          )}
          <button type="button" disabled title={t.downloadSoon}>
            {t.downloadMac}
          </button>
        </nav>
      </div>
    </header>
  );
}
