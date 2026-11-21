import { expect, it } from 'vitest';
import { subscriptionQuotaResetAtMs } from '../../src/account/matrix-account-client.js';

it('uses the later reset when both five-hour and weekly windows are exhausted', () => {
  expect(subscriptionQuotaResetAtMs({ fiveHour: { unlimited: false, remainingPercent: 0, resetAtMs: 5000 }, weekly: { unlimited: false, remainingPercent: 0, resetAtMs: 7000 } }, 1000)).toBe(7000);
});
it('does not wait for a weekly window that still has quota', () => {
  expect(subscriptionQuotaResetAtMs({ fiveHour: { unlimited: false, remainingPercent: 0, resetAtMs: 5000 }, weekly: { unlimited: false, remainingPercent: 20, resetAtMs: 7000 } }, 1000)).toBe(5000);
});
it('does not invent reset timestamps for unavailable, stale or unlimited quota', () => {
  expect(subscriptionQuotaResetAtMs(undefined, 1000)).toBeUndefined();
  expect(subscriptionQuotaResetAtMs({ fiveHour: { unlimited: false, remainingPercent: 0, resetAtMs: 500 }, weekly: { unlimited: true, remainingPercent: 0, resetAtMs: 7000 } }, 1000)).toBeUndefined();
});
