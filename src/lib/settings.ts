import { z } from 'zod';
import { ALL_ROLES } from './roles';
import { LANGUAGES } from './constants';

// Every WhatsApp template the system can send, with the placeholders the worker fills in.
// {{1}} is always the patient's first name and {{2}} the clinic name.
export const TEMPLATE_KEYS = [
  ['appointment_reminder', 'Appointment reminder', '{{3}} date, {{4}} time'],
  ['comfort_checkin', 'Comfort check-in after a visit', 'none beyond name and clinic'],
  ['no_show_recall', 'Missed appointment recall', 'none beyond name and clinic'],
  ['lapsed_recall', 'Lapsed patient recall', 'none beyond name and clinic'],
  ['payment_reminder', 'Overdue instalment reminder', '{{3}} amount, {{4}} due date'],
  ['feedback_request', 'Feedback request (reply 1 to 5)', 'none beyond name and clinic'],
  ['google_review', 'Google review request', '{{3}} review link'],
  ['slot_offer', 'Earlier slot offer (waitlist)', '{{3}} date, {{4}} time'],
] as const;

// "Vizag, Visakhapatnam" -> ['vizag', 'visakhapatnam']. Lower-cased because routing compares ignoring case.
export function parseCities(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(/[,\n]/)) {
    const c = part.trim().toLowerCase();
    if (c.length >= 2 && c.length <= 60) seen.add(c);
  }
  return [...seen].slice(0, 20);
}

const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.null(), z.undefined()])
  .transform((v) => v === 'on' || v === 'true');

export const clinicSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  home_cities: z.string().max(1000).transform(parseCities),
  booking_url: z
    .string().trim()
    .refine((v) => v === '' || /^https:\/\/\S+$/.test(v), 'The booking link must start with https://')
    .transform((v) => (v === '' ? null : v)),
  review_fee_inr: z.coerce.number().int().min(0).max(100000),
  reply_sla_minutes: z.coerce.number().int().min(5).max(2880),
  // Shown in "Meet your orthodontist" on the public Smile Passport page. Empty hides the section.
  orthodontist_name: z.string().trim().max(120).optional().transform((v) => v || null),
  orthodontist_bio: z.string().trim().max(1000).optional().transform((v) => v || null),
});

export const templateSchema = z
  .object({
    key: z.enum(TEMPLATE_KEYS.map(([k]) => k) as unknown as [string, ...string[]]),
    language: z.enum(LANGUAGES.map(([k]) => k) as [string, ...string[]]),
    // WhatsApp template names are lower-case letters, digits and underscores.
    provider_template_name: z
      .string().trim()
      .refine((v) => v === '' || /^[a-z0-9_]{1,200}$/.test(v), 'Template name: lower-case letters, digits and underscores only')
      .transform((v) => (v === '' ? null : v)),
    body: z.string().trim().min(5).max(1024),
    approved: checkbox,
  })
  .refine((v) => !v.approved || !!v.provider_template_name, {
    path: ['provider_template_name'],
    message: 'Enter the approved template name before marking it approved',
  });

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  display_name: z.string().trim().min(2, 'Enter their name').max(80),
  role: z.enum(ALL_ROLES as [string, ...string[]]),
});

export const MIN_PASSWORD_LENGTH = 12;

const blankToNull = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 10:00');

// Invoice and receipt details. GST applicability and format: confirm with the clinic's accountant.
export const billingSettingsSchema = z.object({
  legal_name: blankToNull(160),
  gstin: z.string().trim().toUpperCase().optional()
    .refine((v) => !v || /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/.test(v), 'GSTIN should be 15 characters, e.g. 37ABCDE1234F1Z5')
    .transform((v) => v || null),
  address: blankToNull(400),
  invoice_prefix: z.string().trim().toUpperCase()
    .refine((v) => /^[A-Z]{2,4}$/.test(v) && v !== 'RCT', 'Invoice prefix: 2 to 4 letters, not RCT'),
  gst_rate_percent: z.coerce.number().min(0).max(28),
  sac_code: blankToNull(10),
}).transform(({ gst_rate_percent, ...rest }) => ({ ...rest, gst_rate_bps: Math.round(gst_rate_percent * 100) }));

export const scheduleSettingsSchema = z.object({
  open: time,
  close: time,
  days: z.array(z.coerce.number().int().min(1).max(7)).min(1, 'Choose at least one open day'),
  slot_minutes: z.coerce.number().int().min(10).max(120),
  checkin_days_after: z.coerce.number().int().min(0).max(30),
  lapsed_after_days: z.coerce.number().int().min(7).max(365),
  google_review_url: z.string().trim().optional()
    .refine((v) => !v || /^https:\/\/\S+$/.test(v), 'The review link must start with https://')
    .transform((v) => v || null),
}).refine((v) => v.open < v.close, { path: ['close'], message: 'Closing time must be after opening time' })
  .transform(({ open, close, days, ...rest }) => ({ ...rest, opening_hours: { days: [...new Set(days)].sort(), open, close } }));

export const faqSchema = z.object({
  question: z.string().trim().min(5).max(300),
  answer: z.string().trim().min(5).max(1000),
  keywords: z.string().max(300).optional()
    .transform((v) => (v ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 20)),
});

export const priceSchema = z.object({
  treatment: z.string().trim().min(2).max(80),
  min_inr: z.coerce.number().int().min(0).max(10_000_000),
  max_inr: z.coerce.number().int().min(0).max(10_000_000),
  note: blankToNull(200),
}).refine((v) => v.max_inr >= v.min_inr, { path: ['max_inr'], message: 'The top of the range must be at least the bottom' });
