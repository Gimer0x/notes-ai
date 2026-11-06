import type { Locale } from '../i18n/locale';
import type { LegalDoc } from './types';
import { privacy } from './privacy';
import { terms } from './terms';

export function legalDoc(kind: 'terms' | 'privacy', locale: Locale): LegalDoc {
  const pack = kind === 'terms' ? terms : privacy;
  return locale === 'es' ? pack.es : pack.en;
}
