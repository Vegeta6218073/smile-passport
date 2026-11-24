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
    expect(r.orthodontist_name).toBeNull();
  });
  it('keeps the orthodontist profile and treats blank as hidden', () => {
    const r = clinicSettingsSchema.parse({ ...base, orthodontist_name: ' Dr. A ', orthodontist_bio: '' });
    expect(r.orthodontist_name).toBe('Dr. A');
    expect(r.orthodontist_bio).toBeNull();
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

import { billingSettingsSchema, faqSchema, priceSchema, scheduleSettingsSchema } from './settings';

describe('phase 2 settings', () => {
  it('checks GSTIN and converts the rate to basis points', () => {
    const ok = billingSettingsSchema.parse({ invoice_prefix: 'inv', gst_rate_percent: '18', gstin: '37abcde1234f1z5' });
    expect(ok.gst_rate_bps).toBe(1800);
    expect(ok.gstin).toBe('37ABCDE1234F1Z5');
    expect(billingSettingsSchema.safeParse({ invoice_prefix: 'INV', gst_rate_percent: '0', gstin: '123' }).success).toBe(false);
    expect(billingSettingsSchema.safeParse({ invoice_prefix: 'RCT', gst_rate_percent: '0' }).success).toBe(false);
  });
  it('builds opening hours', () => {
    const v = scheduleSettingsSchema.parse({ open: '10:00', close: '19:00', days: ['6', '1', '1'], slot_minutes: '30',
      checkin_days_after: '2', lapsed_after_days: '45', google_review_url: '' });
    expect(v.opening_hours).toEqual({ days: [1, 6], open: '10:00', close: '19:00' });
    expect(v.google_review_url).toBeNull();
    expect(scheduleSettingsSchema.safeParse({ open: '19:00', close: '10:00', days: ['1'], slot_minutes: '30',
      checkin_days_after: '2', lapsed_after_days: '45' }).success).toBe(false);
  });
  it('parses FAQ keywords and price ranges', () => {
    expect(faqSchema.parse({ question: 'Do you do aligners?', answer: 'Yes we do.', keywords: 'Aligners, invisible ,' }).keywords)
      .toEqual(['aligners', 'invisible']);
    expect(priceSchema.safeParse({ treatment: 'Braces', min_inr: '50000', max_inr: '40000' }).success).toBe(false);
  });
});
