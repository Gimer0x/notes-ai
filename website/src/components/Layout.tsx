import { Link, Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { useI18n } from '../i18n/I18nProvider';

export function Layout() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  return (
    <div className={pathname === '/' ? 'page home' : 'page'}>
      <Header />
      <Outlet />
      <footer className="site-legal wrap">
        <Link to="/terms">{t.termsTitle}</Link>
        <Link to="/privacy">{t.privacyTitle}</Link>
      </footer>
    </div>
  );
}
