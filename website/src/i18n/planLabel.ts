import type { MeResponse } from '../api';
import type { Messages } from './locale';

export function planLabel(
  me: Pick<MeResponse, 'plan' | 'planInterval'>,
  t: Messages,
): string {
  if (me.plan !== 'paid') {
    return t.planFree;
  }
  if (me.planInterval === 'year') {
    return t.planPaidYearly;
  }
  if (me.planInterval === 'month') {
    return t.planPaidMonthly;
  }
  return t.planPaid;
}
