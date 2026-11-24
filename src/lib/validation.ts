import { z } from 'zod';
import { LEAD_SOURCES, LANGUAGES, VISIT_TYPES, CHANNELS } from './constants';

const tuple = <T extends readonly (readonly [string, string])[]>(list: T) =>
  list.map(([v]) => v) as [string, ...string[]];

// Indian-style mobile numbers, with optional +91 or 0 prefix and spaces or dashes.
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(\+91|0)?[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.null(), z.undefined()])
  .transform((v) => v === 'on' || v === 'true');

export function isMinor(dob: string, today = new Date()): boolean {
  const d = new Date(dob);
  const cutoff = new Date(today);
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return d > cutoff;
}

export const patientSchema = z
  .object({
    full_name: z.string().trim().min(2, 'Name is required').max(120),
    phone: phoneSchema,
    email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
    sex: optionalText,
    preferred_language: z.enum(tuple(LANGUAGES)).default('en'),
    guardian_name: optionalText,
    guardian_phone: optionalText,
    lead_source: z.enum(tuple(LEAD_SOURCES)).optional().or(z.literal('').transform(() => undefined)),
    consent_data: checkbox,
    whatsapp_opt_in: checkbox,
    confirm_duplicate: checkbox,
  })
  .refine((v) => v.consent_data, { path: ['consent_data'], message: 'Data-processing consent is required' })
  .refine((v) => !v.dob || !isMinor(v.dob) || !!v.guardian_name, {
    path: ['guardian_name'],
    message: 'A guardian is required for patients under 18',
  });

// Editing an existing patient: same fields as registration, without consent (that was captured then).
export const patientEditSchema = z
  .object({
    full_name: z.string().trim().min(2, 'Name is required').max(120),
    phone: phoneSchema,
    email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
    sex: optionalText,
    preferred_language: z.enum(tuple(LANGUAGES)).default('en'),
    guardian_name: optionalText,
    guardian_phone: optionalText,
  })
  .refine((v) => !v.dob || !isMinor(v.dob) || !!v.guardian_name, {
    path: ['guardian_name'],
    message: 'A guardian is required for patients under 18',
  });

export const enquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  lead_source: z.enum(tuple(LEAD_SOURCES), { message: 'How did they hear about us?' }),
  channel: z.enum(tuple(CHANNELS)).default('whatsapp'),
  referrer_note: optionalText,
  message: z.string().trim().max(2000).optional().transform((v) => (v ? v : undefined)),
  preferred_language: z.enum(tuple(LANGUAGES)).default('en'),
});

export const bookingSchema = z.object({
  patient_id: z.string().uuid(),
  doctor_id: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  chair: optionalText,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  minutes: z.coerce.number().int().min(5).max(480).default(30),
  visit_type: z.enum(tuple(VISIT_TYPES)),
});

export const taskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  assignee_id: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  due_at: z.string().optional().or(z.literal('').transform(() => undefined)),
});

// PostgREST .or() filters break on these characters, so strip them from search text.
export function safeSearch(q: string): string {
  return q.replace(/[^\p{L}\p{N}\s+@.-]/gu, '').trim().slice(0, 60);
}
