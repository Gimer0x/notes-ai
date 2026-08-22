export type Locale = 'en' | 'es';
export type Messages = Record<string, string>;

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') {
    return [];
  }
  const listed = navigator.languages?.length ? [...navigator.languages] : [];
  if (navigator.language) {
    listed.push(navigator.language);
  }
  return listed;
}

/** Spanish if the browser/OS prefers it; otherwise English. */
export function detectLocale(): Locale {
  for (const tag of browserLanguages()) {
    if (tag.toLowerCase().startsWith('es')) {
      return 'es';
    }
  }
  return 'en';
}

export function formatAmount(template: string, amount: string): string {
  return template.replace('{amount}', amount);
}
