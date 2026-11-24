import { describe, expect, it } from 'vitest';
import { enquirySchema, isMinor, patientEditSchema, patientSchema, safeSearch } from './validation';

const base = { full_name: 'Asha Rao', phone: '98765 43210', consent_data: 'on' };

describe('patientSchema', () => {
  it('accepts a normal patient and normalises the phone', () => {
    const r = patientSchema.parse(base);
    expect(r.phone).toBe('9876543210');
    expect(r.consent_data).toBe(true);
  });
  it('requires data-processing consent', () => {
    expect(patientSchema.safeParse({ ...base, consent_data: undefined }).success).toBe(false);
  });
  it('rejects bad phone numbers', () => {
    expect(patientSchema.safeParse({ ...base, phone: '12345' }).success).toBe(false);
  });
  it('requires a guardian for minors', () => {
    const year = new Date().getFullYear() - 10;
    expect(patientSchema.safeParse({ ...base, dob: `${year}-01-01` }).success).toBe(false);
    expect(patientSchema.safeParse({ ...base, dob: `${year}-01-01`, guardian_name: 'Parent' }).success).toBe(true);
  });
});

describe('enquirySchema', () => {
  it('requires a lead source', () => {
    expect(enquirySchema.safeParse({ name: 'Lead', phone: '9876543210' }).success).toBe(false);
    expect(enquirySchema.safeParse({ name: 'Lead', phone: '9876543210', lead_source: 'instagram' }).success).toBe(true);
  });
});

describe('helpers', () => {
  it('detects minors', () => {
    expect(isMinor('2000-01-01', new Date('2026-01-01'))).toBe(false);
    expect(isMinor('2015-01-01', new Date('2026-01-01'))).toBe(true);
  });
  it('strips filter syntax from search text', () => {
    expect(safeSearch('a,b)or(c%')).toBe('aborc');
  });
});

describe('patientEditSchema', () => {
  const edit = { full_name: 'Asha Rao', phone: '9876543210' };
  it('does not ask for consent again', () => {
    expect(patientEditSchema.safeParse(edit).success).toBe(true);
  });
  it('still requires a guardian for minors', () => {
    const year = new Date().getFullYear() - 8;
    expect(patientEditSchema.safeParse({ ...edit, dob: `${year}-02-02` }).success).toBe(false);
  });
});
