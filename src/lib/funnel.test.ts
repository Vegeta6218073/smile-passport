import { describe, expect, it } from 'vitest';
import { csvCell, toCsv, weakestStep } from './funnel';

describe('weakestStep', () => {
  it('finds the step with the lowest conversion', () => {
    const w = weakestStep([
      { label: 'Visitors', value: 1000 },
      { label: 'Scans', value: 250 },
      { label: 'Reviews', value: 80 },
      { label: 'Consults', value: 25 },
      { label: 'Treatments', value: 5 },
    ]);
    expect(w?.from).toBe('Consults');
    expect(w?.to).toBe('Treatments');
    expect(w?.rate).toBeCloseTo(0.2);
  });

  it('skips steps after an empty step', () => {
    expect(weakestStep([{ label: 'A', value: 0 }, { label: 'B', value: 0 }])).toBeNull();
  });
});

describe('csvCell', () => {
  it('quotes commas, quotes and new lines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises formulas but keeps phone numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('+919876543210')).toBe('+919876543210');
    expect(csvCell('-1+2')).toBe("'-1+2");
  });

  it('writes empty cells for null', () => {
    expect(toCsv(['a', 'b'], [[null, 1]])).toBe('a,b\r\n,1\r\n');
  });
});
