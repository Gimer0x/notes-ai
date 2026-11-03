import { parseSummaryBullets, summarySectionLimit } from './summary.service';

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
      '  1. A nested point',
      '  2. Post it',
      '• Iterate',
    ]);
  });

  it('turns a single bullet with a numbered list into several bullets', () => {
    const bullets = parseSummaryBullets(`# Insights
• Mark covered the debt bubble.
  1. Companies spend more than they earn.
  2. A bubble could burst.
  3. Stay ahead in technology.`);
    expect(bullets).toEqual([
      '# Insights',
      '• Mark covered the debt bubble.',
      '• Companies spend more than they earn.',
      '• A bubble could burst.',
      '• Stay ahead in technology.',
    ]);
  });

  it('keeps at most five bullets and five numbered details', () => {
    const lines = [
      '# Topic',
      ...Array.from({ length: 6 }, (_, index) => `• Bullet ${index + 1}`),
      ...Array.from({ length: 6 }, (_, index) => `  • Detail ${index + 1}`),
    ].join('\n');
    const bullets = parseSummaryBullets(lines, 4);
    expect(bullets.filter((line) => line.startsWith('• '))).toHaveLength(5);
    expect(bullets.filter((line) => line.startsWith('  '))).toEqual([
      '  1. Detail 1',
      '  2. Detail 2',
      '  3. Detail 3',
      '  4. Detail 4',
      '  5. Detail 5',
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

  it('sets the section ceiling from the meeting length', () => {
    expect(summarySectionLimit(5 * 60)).toBe(4);
    expect(summarySectionLimit(10 * 60 - 1)).toBe(4);
    expect(summarySectionLimit(10 * 60)).toBe(8);
    expect(summarySectionLimit(20 * 60 - 1)).toBe(8);
    expect(summarySectionLimit(20 * 60)).toBe(8);
    expect(summarySectionLimit(30 * 60 - 1)).toBe(8);
    expect(summarySectionLimit(30 * 60)).toBe(10);
    expect(summarySectionLimit(90 * 60)).toBe(10);
    expect(summarySectionLimit(null)).toBe(10);
  });

  it('keeps the closing section when a short meeting is trimmed', () => {
    const lines = [
      '# Conclusions',
      '• Wrap up',
      '# Topic A',
      '• First',
      '# Topic B',
      '• Second',
      '# Topic C',
      '• Third',
      '# Topic D',
      '• Fourth',
    ].join('\n');
    const headings = parseSummaryBullets(lines, summarySectionLimit(5 * 60)).filter((line) =>
      line.startsWith('# '),
    );
    expect(headings).toEqual(['# Topic A', '# Topic B', '# Topic C', '# Conclusions']);
  });

  it('leaves a summary without a closing section unchanged', () => {
    const headings = parseSummaryBullets('# Topic A\n• First\n# Topic B\n• Second', 3).filter((line) =>
      line.startsWith('# '),
    );
    expect(headings).toEqual(['# Topic A', '# Topic B']);
  });
});
