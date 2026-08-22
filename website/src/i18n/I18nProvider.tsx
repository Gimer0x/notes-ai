import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import en from '../i18n/en.json';
import es from '../i18n/es.json';
import { detectLocale, type Locale, type Messages } from '../i18n/locale';

type I18nValue = {
  locale: Locale;
  t: Messages;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = detectLocale();
  const t = locale === 'es' ? es : en;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, t }), [locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return ctx;
}
