import { describe, expect, it } from 'vitest';
import { clinicSettingsSchema, inviteSchema, parseCities, templateSchema } from './settings';

describe('parseCities', () => {
  it('lower-cases, trims and removes duplicates', () => {
    expect(parseCities(' Vizag, visakhapatnam\nVIZAG ,')).toEqual(['vizag', 'visakhapatnam']);
  });
  it('ignores junk', () => {
    expect(parseCities(', ,a')).toEqual([]);
  });
});

describe('clinicSettingsSchema', () => {
  const base = { name: 'Dev Clinic', home_cities: 'Vizag', booking_url: '', review_fee_inr: '999', reply_sla_minutes: '120' };
  it('accepts valid settings', () => {
    const r = clinicSettingsSchema.parse(base);
    expect(r.home_cities).toEqual(['vizag']);
    expect(r.booking_url).toBeNull();
    expect(r.review_fee_inr).toBe(999);
  });
  it('requires an https booking link', () => {
    expect(clinicSettingsSchema.safeParse({ ...base, booking_url: 'http://x.com' }).success).toBe(false);
    expect(clinicSettingsSchema.safeParse({ ...base, booking_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(clinicSettingsSchema.safeParse({ ...base, booking_url: 'https://cal.com/x' }).success).toBe(true);
  });
  it('rejects a negative fee and a silly SLA', () => {
    expect(clinicSettingsSchema.safeParse({ ...base, review_fee_inr: '-1' }).success).toBe(false);
    expect(clinicSettingsSchema.safeParse({ ...base, reply_sla_minutes: '1' }).success).toBe(false);
  });
});

describe('templateSchema', () => {
  const base = { key: 'appointment_reminder', language: 'en', provider_template_name: '', body: 'Hi {{1}}, see you soon', approved: undefined };
  it('allows a draft without a provider name', () => {
    expect(templateSchema.safeParse(base).success).toBe(true);
  });
  it('will not mark a template approved without its provider name', () => {
    expect(templateSchema.safeParse({ ...base, approved: 'on' }).success).toBe(false);
    expect(templateSchema.safeParse({ ...base, approved: 'on', provider_template_name: 'appt_reminder_en' }).success).toBe(true);
  });
  it('rejects badly formed provider names', () => {
    expect(templateSchema.safeParse({ ...base, provider_template_name: 'Appt Reminder' }).success).toBe(false);
  });
});

describe('inviteSchema', () => {
  it('normalises the email and checks the role', () => {
    expect(inviteSchema.parse({ email: ' A@B.com ', display_name: 'Asha', role: 'doctor' }).email).toBe('a@b.com');
    expect(inviteSchema.safeParse({ email: 'a@b.com', display_name: 'Asha', role: 'admin' }).success).toBe(false);
  });
});
