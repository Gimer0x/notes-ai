import { monthlyWindow, paidAccessEnded } from './billing.service';

describe('monthlyWindow', () => {
  const anchor = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));

  it('ends a January 31 anchor on February 28', () => {
    const window = monthlyWindow(anchor, new Date(Date.UTC(2026, 0, 31, 13, 0, 0)));
    expect(window.start.toISOString()).toBe('2026-01-31T12:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-02-28T12:00:00.000Z');
  });

  it('keeps the 31st-day anniversary after February', () => {
    const window = monthlyWindow(anchor, new Date(Date.UTC(2026, 1, 28, 13, 0, 0)));
    expect(window.start.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-31T12:00:00.000Z');
  });

  it('does not start a window in the future', () => {
    const window = monthlyWindow(anchor, new Date(Date.UTC(2026, 2, 1, 13, 0, 0)));
    expect(window.start.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-31T12:00:00.000Z');
    expect(window.start.getTime()).toBeLessThanOrEqual(Date.UTC(2026, 2, 1, 13, 0, 0));
    expect(window.end.getTime()).toBeGreaterThan(Date.UTC(2026, 2, 1, 13, 0, 0));
  });

  it('crosses the year boundary from December 31', () => {
    const yearEnd = new Date(Date.UTC(2026, 11, 31, 12, 0, 0));
    const window = monthlyWindow(yearEnd, new Date(Date.UTC(2027, 0, 15, 12, 0, 0)));
    expect(window.start.toISOString()).toBe('2026-12-31T12:00:00.000Z');
    expect(window.end.toISOString()).toBe('2027-01-31T12:00:00.000Z');
  });
});

describe('paidAccessEnded', () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);

  it('ends paused access at the period end', () => {
    expect(
      paidAccessEnded({
        plan_code: 'paid',
        subscription_paused: true,
        subscription_period_end: past,
      }),
    ).toBe(true);
    expect(
      paidAccessEnded({
        plan_code: 'paid',
        subscription_paused: true,
        subscription_period_end: future,
      }),
    ).toBe(false);
  });

  it('keeps an active renewal inside the one-day grace', () => {
    expect(
      paidAccessEnded({
        plan_code: 'paid',
        subscription_paused: false,
        subscription_period_end: past,
      }),
    ).toBe(false);
  });
});
