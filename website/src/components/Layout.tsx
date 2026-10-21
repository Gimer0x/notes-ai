import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';

export function Layout() {
  const { pathname } = useLocation();
  return (
    <div className={pathname === '/' ? 'page home' : 'page'}>
      <Header />
      <Outlet />
    </div>
  );
}
