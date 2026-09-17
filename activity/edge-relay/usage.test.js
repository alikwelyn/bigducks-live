import { expect, it } from 'vitest';
import { addUsage, clampReportedBytes, freshUsage, gigabytes, monthKey, usageSummary, MAX_REPORTED_BYTES } from './usage.js';

it('keeps a monthly total that never mixes billing periods', () => {
  const january = Date.UTC(2026, 0, 15);
  const february = Date.UTC(2026, 1, 2);
  let usage = addUsage(freshUsage(january), { relay: 1000, now: january });
  expect(usageSummary(usage, january).gigabytes).toBe(0);
  expect(usageSummary(usage, january).bytes).toBe(1000);
  usage = addUsage(usage, { sfu: 2000, now: february });
  expect(usage.month).toBe('2026-02');
  expect(usageSummary(usage, february).bytes).toBe(2000);
  expect(monthKey(january)).toBe('2026-01');
});

it('treats a client-reported figure as a hint and clamps it', () => {
  expect(clampReportedBytes(5_000_000)).toBe(5_000_000);
  expect(clampReportedBytes(MAX_REPORTED_BYTES * 5)).toBe(MAX_REPORTED_BYTES);
  for (const value of [-1, 0, NaN, Infinity, undefined, 'x']) expect(clampReportedBytes(value)).toBe(0);
});

it('reports whole gigabytes with two decimals', () => {
  expect(gigabytes(0)).toBe(0);
  expect(gigabytes(1_170_000_000)).toBe(1.17);
  expect(gigabytes(-5)).toBe(0);
});
