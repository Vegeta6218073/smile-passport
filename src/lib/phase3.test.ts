import { describe, expect, it } from 'vitest';
import { detectDocumentType, isFdiTooth, latestByTooth } from './clinical';
import { LINES, change, periodRange, summaryMetrics } from './dashboard';

describe('tooth chart', () => {
  it('accepts FDI permanent and primary teeth only', () => {
    for (const t of ['11', '18', '48', '55', '85']) expect(isFdiTooth(t)).toBe(true);
    for (const t of ['19', '10', '49', '56', '91', 'UR6', '']) expect(isFdiTooth(t)).toBe(false);
  });
  it('keeps the newest entry per tooth', () => {
    const m = latestByTooth([{ tooth: '36', c: 'bracket' }, { tooth: '36', c: 'decayed' }, { tooth: '11', c: 'crown' }]);
    expect(m.get('36')?.c).toBe('bracket');
    expect(m.size).toBe(2);
  });
});

describe('documents', () => {
  it('decides the file type from its first bytes', () => {
    expect(detectDocumentType(new TextEncoder().encode('%PDF-1.7'))?.type).toBe('application/pdf');
    expect(detectDocumentType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))?.ext).toBe('jpg');
    expect(detectDocumentType(new TextEncoder().encode('<html>'))).toBeNull();
  });
});

describe('dashboard', () => {
  it('compares a period with the one right before it', () => {
    expect(periodRange('week', '2026-12-07')).toMatchObject({ from: '2026-12-01', to: '2026-12-07', prevFrom: '2026-11-24', prevTo: '2026-11-30' });
  });
  it('defines rates from counts', () => {
    const noShow = LINES.find((l) => l.key === 'no_show_rate')!;
    expect(noShow.value({ no_shows: 2, appointments_held: 8 })).toBe(25);
    expect(noShow.value({})).toBe(0);
    expect(change(12, 10)).toBe('+20%');
    expect(change(3, 0)).toBe('new');
  });
  it('builds the weekly summary inputs without money for roles that cannot see it', () => {
    const m = summaryMetrics({ leads: 5, collected_paise: 500000 }, { leads: 4, collected_paise: 0 }, false);
    expect(m.some((x) => x.key === 'collected')).toBe(false);
    const withMoney = summaryMetrics({ collected_paise: 500000 }, {}, true);
    expect(withMoney.find((x) => x.key === 'collected')?.current).toBe(5000);
    expect(withMoney.find((x) => x.key === 'conversion')?.unit).toBe('%');
  });
});
