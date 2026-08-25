import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n/I18nProvider';

export function Header() {
  const { t } = useI18n();
  const { signedIn, me, signIn, signOut } = useAuth();

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
              <span className="status">
                {t.signedInAs
                  .replace('{email}', me?.email ?? '')
                  .replace('{plan}', me?.plan === 'paid' ? t.planPaid : t.planFree)}
              </span>
              <button type="button" className="secondary" onClick={() => void signOut()}>
                {t.signOut}
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={() => void signIn()}>
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
