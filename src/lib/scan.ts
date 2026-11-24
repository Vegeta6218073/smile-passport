import { z } from 'zod';

export const PHOTO_KINDS = ['front_smile', 'front_teeth', 'side_profile'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
export const REQUIRED_PHOTOS: PhotoKind[] = ['front_smile', 'front_teeth'];
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_SCANS_PER_PHONE_PER_DAY = 3;
export const SCAN_CONSENT_VERSION = 'draft-v0'; // TODO(counsel): replace with the reviewed text

export const PHOTO_LABELS: Record<PhotoKind, string> = {
  front_smile: 'Front smiling photo',
  front_teeth: 'Front teeth photo',
  side_profile: 'Side profile (optional)',
};

// The browser's file type is user-controlled, so decide from the file's first bytes.
export function detectImageType(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'webp';
  return null;
}

export const EXTENSION = { jpeg: 'jpg', png: 'png', webp: 'webp' } as const;
export const CONTENT_TYPE = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

// Smile Passport also serves patients abroad, so accept international numbers, not just Indian ones.
export const contactPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .refine((v) => /^\+?\d{8,15}$/.test(v), 'Enter a valid phone number, with country code if outside India');

const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.null(), z.undefined()])
  .transform((v) => v === 'on' || v === 'true');

const optional = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const scanSubmitSchema = z.object({
  full_name: z.string().trim().min(2, 'Please enter your name').max(120),
  phone: contactPhoneSchema,
  email: z.string().trim().email('Enter a valid email').optional().or(z.literal('').transform(() => undefined)),
  city: z.string().trim().min(2, 'Please enter your city').max(80),
  country: z.string().trim().max(60).optional().transform((v) => v || 'India'),
  main_concern: optional(500),
  source: optional(60),
  consent_data: checkbox,
  consent_whatsapp: checkbox,
  // Honeypot: real visitors never see or fill this field.
  website: z.string().max(0).optional().or(z.literal('')),
}).refine((v) => v.consent_data, { path: ['consent_data'], message: 'Please accept the data consent to continue' });

// Staff-side helper: a wa.me link that opens a WhatsApp chat with a prefilled message.
// A 10-digit Indian number gets +91; anything with a country code is used as typed.
export function waLink(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, '');
  const full = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

export const STATUS_LABEL: Record<string, string> = {
  submitted: 'New',
  in_review: 'In review',
  needs_better_photos: 'Needs better photos',
  report_ready: 'Report ready',
  report_sent: 'Report sent',
  consult_booked: 'Consultation booked',
  treatment_started: 'Treatment started',
  closed: 'Closed',
};
