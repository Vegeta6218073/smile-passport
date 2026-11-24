import { describe, expect, it } from 'vitest';
import { classifyText, draftReply, explainPlanText, summarise } from './ai/rules';
import { fillName, redact } from './ai/redact';
import { featureOn, reviewOutcome } from './ai/gateway';
import { openSlots } from './ai/slots';
import { rankQueue, scoreRow } from './queue';
import { mapHeaders, normaliseDate, parseCsv, toImportRows } from './importer';
import { parseRupees, rupees } from './money';
import { localToUtc, zoneOffsetMinutes } from './dates';

describe('reply classification (rules)', () => {
  it.each([
    ['all good, thanks', 'fine'],
    ['theek hai', 'fine'],
    ['👍', 'fine'],
    ['no pain at all', 'fine'],
    ['dard nahi hai', 'fine'],
    ['bit of pain when chewing', 'mild'],
    ['bracket came off', 'mild'],
    ['my gums are bleeding', 'urgent'],
    ['bahut dard ho raha hai', 'urgent'],
    ['swelling on the left side', 'urgent'],
    ['wire is poking my cheek', 'urgent'],
    ['मसूड़ों से खून आ रहा है', 'urgent'],
    ['fine but a wire is loose', 'unknown'],
    ['can I change my appointment?', 'unknown'],
    ['not feeling good', 'mild'],
  ])('"%s" is %s', (text, label) => {
    expect(classifyText(text).label).toBe(label);
  });

  it('gives low confidence to unclear replies so a person reads them', () => {
    expect(classifyText('ଭଲ ଅଛି').confidence).toBeLessThan(0.8);
    expect(classifyText('').label).toBe('unknown');
  });
});

describe('identifier minimisation', () => {
  it('removes names, phone numbers and emails', () => {
    const out = redact('Asha Rao here, call 98765 43210 or asha@x.com', ['Asha Rao']);
    expect(out).not.toMatch(/Asha|Rao|98765|asha@/);
    expect(out).toContain('[name]');
    expect(out).toContain('[number]');
    expect(out).toContain('[email]');
  });
  it('does not touch parts of other words', () => {
    expect(redact('Ravindra visited', ['Ravi'])).toBe('Ravindra visited');
  });
  it('puts the first name back into a draft', () => {
    expect(fillName('Hi {{name}},', 'Asha Rao')).toBe('Hi Asha,');
  });
});

describe('enquiry drafts', () => {
  const base = {
    clinicName: 'Smile Clinic', language: 'en',
    faqs: [{ question: 'Do you offer clear aligners?', answer: 'Yes, we offer clear aligners.', keywords: ['aligners', 'invisible'] }],
    prices: [{ treatment: 'Aligners', min_inr: 80000, max_inr: 200000 }],
    slots: ['Tue 3 Dec, 11:00 am'],
  };
  it('uses approved answers, prices and slots', () => {
    const d = draftReply({ ...base, question: 'How much do invisible aligners cost?' });
    expect(d.grounded).toBe(true);
    expect(d.text).toContain('Yes, we offer clear aligners.');
    expect(d.text).toContain('₹80,000 to ₹2,00,000');
    expect(d.text).toContain('Tue 3 Dec');
    expect(d.text).toContain('{{name}}');
  });
  it('says so and hands over when nothing matches', () => {
    const d = draftReply({ ...base, question: 'Is parking available?', slots: [] });
    expect(d.grounded).toBe(false);
    expect(d.text).toContain('A member of our team will answer');
  });
  it('does not draft in unsupported languages', () => {
    expect(draftReply({ ...base, language: 'or', question: 'aligners?' }).handover).toBe(true);
  });
  it('explains a plan in plain words', () => {
    const d = explainPlanText({ language: 'en', title: 'Fixed braces', options: 'Metal braces on both arches',
      durationMonths: 18, costInr: 60000, instalments: 6 });
    expect(d.text).toContain('18 months');
    expect(d.text).toContain('6 instalments');
  });
});

describe('weekly summary', () => {
  it('puts what is slipping first and links each line', () => {
    const lines = summarise([
      { key: 'leads', label: 'Leads', current: 12, previous: 10, better: 'up', href: '/dashboard#leads' },
      { key: 'noshow', label: 'No-shows', current: 5, previous: 2, better: 'down', href: '/dashboard#visits' },
    ]);
    expect(lines[0].tone).toBe('bad');
    expect(lines[0].href).toBe('/dashboard#visits');
    expect(lines[1].text).toContain('Leads rose to 12 from 10 (+20%)');
  });
});

describe('AI switches and review', () => {
  it('respects the clinic and feature switches', () => {
    expect(featureOn({ ai_enabled: false, ai_features: {} }, 'enquiry_reply')).toBe(false);
    expect(featureOn({ ai_enabled: true, ai_features: { enquiry_reply: false } }, 'enquiry_reply')).toBe(false);
    expect(featureOn({ ai_enabled: true, ai_features: {} }, 'enquiry_reply')).toBe(true);
  });
  it('tracks whether a draft was edited', () => {
    expect(reviewOutcome('Hi  there', 'Hi there', false)).toBe('sent');
    expect(reviewOutcome('Hi there', 'Hello there', false)).toBe('edited_sent');
    expect(reviewOutcome('Hi', 'Hi', true)).toBe('discarded');
  });
});

describe('time zones and slots', () => {
  it('converts clinic time to UTC', () => {
    expect(zoneOffsetMinutes('Asia/Kolkata', new Date('2026-12-01T00:00:00Z'))).toBe(330);
    expect(localToUtc('2026-12-01', '10:00', 'Asia/Kolkata').toISOString()).toBe('2026-12-01T04:30:00.000Z');
  });
  it('offers the first free slot per open day, skipping busy times', () => {
    const slots = openSlots({
      hours: { days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '12:00' },
      slotMinutes: 30, timeZone: 'Asia/Kolkata',
      now: new Date('2026-11-30T20:00:00Z'),    // Tue 1 Dec 01:30 in Kolkata
      busy: [{ starts_at: '2026-12-01T04:30:00Z', ends_at: '2026-12-01T05:00:00Z' }],
    });
    expect(slots[0].toISOString()).toBe('2026-12-01T05:00:00.000Z');   // 10:30, since 10:00 is taken
    expect(slots).toHaveLength(3);
  });
});

describe('Today queue ranking', () => {
  const now = new Date('2026-12-01T10:00:00Z').getTime();
  it('puts urgent concerns first and explains every rank', () => {
    const ranked = rankQueue([
      { kind: 'task', ref_id: '1', patient_id: null, title: 'Call lab', due_at: '2026-12-01T09:00:00Z' },
      { kind: 'concern', ref_id: '2', patient_id: 'p', title: 'Urgent', due_at: null, severity: 'urgent' },
      { kind: 'enquiry_unreplied', ref_id: '3', patient_id: null, title: 'Reply', due_at: '2026-12-01T07:00:00Z' },
    ], now);
    expect(ranked.map((r) => r.ref_id)).toEqual(['2', '3', '1']);
    expect(ranked[1].reason).toContain('3 h past the reply target');
  });
  it('weighs patient history on overdue steps', () => {
    const a = scoreRow({ kind: 'overdue_step', ref_id: 'a', patient_id: 'p', title: '', due_at: '2026-11-21T10:00:00Z', patient_no_shows: 2 }, now);
    const b = scoreRow({ kind: 'overdue_step', ref_id: 'b', patient_id: 'p', title: '', due_at: '2026-11-21T10:00:00Z', patient_no_shows: 0 }, now);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.reason).toContain('missed 2 visits');
  });
});

describe('patient import', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
  it('maps common header names', () => {
    expect(mapHeaders(['Patient Name', 'Mobile Number', 'DOB']).missing).toEqual([]);
    expect(mapHeaders(['Name']).missing).toEqual(['phone']);
  });
  it('normalises dates, sources and languages', () => {
    expect(normaliseDate('5/1/1990')).toBe('1990-01-05');
    const { rows } = toImportRows('Name,Phone,Source,Language,DOB\nAsha,9876543210,Instagram,Hindi,31-01-1990\nRavi,9876500000,Newspaper,,');
    expect(rows[0]).toMatchObject({ row: 2, lead_source: 'instagram', preferred_language: 'hi', dob: '1990-01-31' });
    expect(rows[1].lead_source).toBeUndefined();
    expect(rows[1].notes).toBe('Source: Newspaper');
  });
});

describe('money', () => {
  it('formats and parses rupees', () => {
    expect(rupees(12345600)).toBe('₹1,23,456');
    expect(rupees(150)).toBe('₹1.50');
    expect(parseRupees('12,500')).toBe(1250000);
    expect(parseRupees('0')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
  });
});

import { routePattern } from './usage';
describe('usage analytics', () => {
  it('keeps route patterns only', () => {
    expect(routePattern('/patients/3f2b1c4d-1111-2222-3333-444455556666?tab=x')).toBe('/patients/[id]');
    expect(routePattern('/Today')).toBe('/today');
    expect(routePattern('/search/<script>')).toBeNull();
  });
});
