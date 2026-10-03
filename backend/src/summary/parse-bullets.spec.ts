import { parseSummaryBullets } from './summary.service';

describe('parseSummaryBullets', () => {
  it('keeps one fact per line and drops markers', () => {
    const bullets = parseSummaryBullets(`- Keep the proposal
2. Write the alternative
• Drop the open research`);
    expect(bullets).toEqual([
      'Keep the proposal',
      'Write the alternative',
      'Drop the open research',
    ]);
  });
});
