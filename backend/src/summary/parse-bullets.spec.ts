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
});
