import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { Layout } from './components/Layout';
import { I18nProvider } from './i18n/I18nProvider';
import { HomePage } from './pages/HomePage';
import { PricingPage } from './pages/PricingPage';
import { AccountPage } from './pages/AccountPage';
import { AuthCallbackPage } from './pages/AuthCallbackPage';

export function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  );
}
