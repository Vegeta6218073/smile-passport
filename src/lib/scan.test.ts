import { describe, expect, it } from 'vitest';
import { contactPhoneSchema, detectImageType, scanSubmitSchema, waLink } from './scan';

describe('detectImageType', () => {
  it('recognises real image headers', () => {
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('jpeg');
    expect(detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    const webp = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0))));
    expect(detectImageType(webp)).toBe('webp');
  });
  it('rejects anything else, whatever the file is called', () => {
    expect(detectImageType(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // "<svg"
    expect(detectImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // PDF
    expect(detectImageType(new Uint8Array([]))).toBeNull();
  });
});

describe('contactPhoneSchema', () => {
  it('accepts Indian and international numbers', () => {
    expect(contactPhoneSchema.parse('98765 43210')).toBe('9876543210');
    expect(contactPhoneSchema.parse('+971 50 123 4567')).toBe('+971501234567');
  });
  it('rejects junk', () => {
    expect(contactPhoneSchema.safeParse('abc').success).toBe(false);
    expect(contactPhoneSchema.safeParse('123').success).toBe(false);
  });
});

describe('scanSubmitSchema', () => {
  const ok = { full_name: 'Asha Rao', phone: '9876543210', city: 'Vizag', consent_data: 'on' };
  it('accepts a valid scan and defaults the country', () => {
    const r = scanSubmitSchema.parse(ok);
    expect(r.country).toBe('India');
    expect(r.consent_whatsapp).toBe(false);
  });
  it('needs data consent', () => {
    expect(scanSubmitSchema.safeParse({ ...ok, consent_data: undefined }).success).toBe(false);
  });
  it('rejects a filled honeypot', () => {
    expect(scanSubmitSchema.safeParse({ ...ok, website: 'http://spam' }).success).toBe(false);
  });
});

describe('waLink', () => {
  it('adds +91 to ten-digit numbers and encodes the text', () => {
    expect(waLink('98765 43210', 'Hi there')).toBe('https://wa.me/919876543210?text=Hi%20there');
  });
  it('keeps numbers that already have a country code', () => {
    expect(waLink('+971501234567', 'x')).toBe('https://wa.me/971501234567?text=x');
  });
});
