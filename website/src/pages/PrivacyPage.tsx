import { LegalDocument } from '../components/LegalDocument';
import { useI18n } from '../i18n/I18nProvider';
import { legalDoc } from '../legal/docs';

export function PrivacyPage() {
  const { locale, t } = useI18n();
  return <LegalDocument doc={legalDoc('privacy', locale)} backLabel={t.welcomeBack} />;
}
