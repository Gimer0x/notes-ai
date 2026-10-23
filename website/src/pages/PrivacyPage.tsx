import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider';

export function PrivacyPage() {
  const { t } = useI18n();
  return (
    <article className="wrap legal">
      <h1>{t.privacyTitle}</h1>
      <p>{t.privacyBody}</p>
      <p>
        <Link to="/welcome">{t.welcomeBack}</Link>
      </p>
    </article>
  );
}
