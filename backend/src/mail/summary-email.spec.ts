import { buildSummaryEmail } from './summary-email';

describe('buildSummaryEmail', () => {
  it('uses Notes for subject and title line without quotes in the body', () => {
    const email = buildSummaryEmail({
      title: "Gimer's Introduction",
      dateLabel: '2026-10-27',
      lines: [
        '# Attendee Introduction',
        '• Ximer introduced himself.',
        '  1. First point',
        '# Conclusions',
        '• Strong background.',
      ],
    });
    expect(email.subject).toBe('Notes for "Gimer\'s Introduction" - 2026-10-27');
    expect(email.text).toContain('Meeting notes');
    expect(email.text).toContain("Gimer's Introduction 2026-10-27");
    expect(email.html).toContain('Meeting notes');
    expect(email.html).toContain('Gimer&#39;s Introduction 2026-10-27');
    expect(email.html).not.toContain('Notes for &quot;');
    expect(email.html).not.toContain('cid:pith-logo');
    expect(email.html).toContain('Attendee Introduction');
    expect(email.html).not.toContain('# Attendee');
    expect(email.html).toMatch(/padding-left:30px[^>]*>[\s\S]*?1\./);
  });
});

