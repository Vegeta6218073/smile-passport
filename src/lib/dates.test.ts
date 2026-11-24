import { describe, expect, it } from 'vitest';
import { shiftDay, todayIn } from './dates';

describe('dates', () => {
  it('uses the clinic time zone for "today"', () => {
    const lateUtc = new Date('2026-11-23T20:00:00Z'); // already Nov 24 in Kolkata
    expect(todayIn('Asia/Kolkata', lateUtc)).toBe('2026-11-24');
    expect(todayIn('UTC', lateUtc)).toBe('2026-11-23');
  });
  it('shifts days across month ends', () => {
    expect(shiftDay('2026-11-30', 1)).toBe('2026-12-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});
