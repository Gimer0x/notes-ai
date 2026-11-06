import { Link } from 'react-router-dom';
import type { LegalDoc } from '../legal/types';

export function LegalDocument({ doc, backLabel }: { doc: LegalDoc; backLabel: string }) {
  return (
    <article className="wrap legal">
      <h1>{doc.title}</h1>
      <p className="legal-updated">{doc.updated}</p>
      {doc.intro.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {doc.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {section.bullets ? (
            <ul>
              {section.bullets.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
      <p>
        <Link to="/welcome">{backLabel}</Link>
      </p>
    </article>
  );
}
