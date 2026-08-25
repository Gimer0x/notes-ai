import { describe, expect, it } from 'vitest';
import en from './en.json';
import es from './es.json';
import { planLabel } from './planLabel';

const messages = en;

describe('planLabel', () => {
  it('labels free, paid monthly, paid yearly, and paid without interval', () => {
    expect(planLabel({ plan: 'free', planInterval: null }, messages)).toBe(
      messages.planFree,
    );
    expect(
      planLabel({ plan: 'paid', planInterval: 'month' }, messages),
    ).toBe(messages.planPaidMonthly);
    expect(
      planLabel({ plan: 'paid', planInterval: 'year' }, messages),
    ).toBe(messages.planPaidYearly);
    expect(planLabel({ plan: 'paid', planInterval: null }, messages)).toBe(
      messages.planPaid,
    );
  });
});

describe('i18n', () => {
  it('keeps the same keys in English and Spanish', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });
});
