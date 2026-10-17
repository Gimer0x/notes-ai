import { parseSummaryBullets } from './summary.service';

describe('parseSummaryBullets', () => {
  it('keeps headings, dot bullets, and numbered steps', () => {
    const bullets = parseSummaryBullets(`# Close
- The team agrees
  • A nested point
  1. Post it
2. Iterate`);
    expect(bullets).toEqual([
      '# Close',
      '• The team agrees',
      '  • A nested point',
      '  1. Post it',
      '2. Iterate',
    ]);
  });

  it('keeps at most eight sections and leaves conclusions last', () => {
    const lines = [
      '# Conclusions',
      '• Wrap up',
      ...Array.from({ length: 9 }, (_, index) => `# Topic ${index + 1}\n• Point ${index + 1}`),
    ].join('\n');
    const bullets = parseSummaryBullets(lines);
    const headings = bullets.filter((line) => line.startsWith('# '));
    expect(headings).toHaveLength(8);
    expect(headings[7]).toBe('# Conclusions');
    expect(headings[0]).toBe('# Topic 1');
  });
});
