import { z } from 'zod';
import { ALL_ROLES } from './roles';
import { LANGUAGES } from './constants';

export const TEMPLATE_KEYS = [['appointment_reminder', 'Appointment reminder']] as const;

// Placeholders the worker fills in for the appointment reminder template.
export const REMINDER_PLACEHOLDERS = '{{1}} patient first name, {{2}} clinic name, {{3}} date, {{4}} time';

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
});

export const templateSchema = z
  .object({
    key: z.enum(TEMPLATE_KEYS.map(([k]) => k) as [string, ...string[]]),
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
