// Clinical record helpers (roadmap #30, #31). FDI notation is a draft choice: confirm with the doctor.
export const TOOTH_CONDITIONS = [
  'bracket', 'band', 'attachment', 'missing', 'extracted', 'impacted', 'decayed', 'filled', 'crown', 'rotated', 'other',
] as const;

export const PERMANENT_TEETH = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38].map(String);

export function isFdiTooth(t: string): boolean {
  return /^([1-4][1-8]|[5-8][1-5])$/.test(t.trim());
}

// Latest condition per tooth, from newest-first entries.
export function latestByTooth<T extends { tooth: string }>(entries: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const e of entries) if (!m.has(e.tooth)) m.set(e.tooth, e);
  return m;
}

export const DOCUMENT_KINDS = [
  ['photo', 'Photo'], ['xray', 'X-ray'], ['consent_form', 'Consent form'], ['scan', 'Scan'], ['report', 'Report'], ['other', 'Other'],
] as const;

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export function detectDocumentType(bytes: Uint8Array): { ext: string; type: string } | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return { ext: 'pdf', type: 'application/pdf' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return { ext: 'webp', type: 'image/webp' };
  }
  return null;
}

export const DECLINE_REASONS = [
  ['price', 'Price'], ['timing', 'Timing'], ['second_opinion', 'Wants a second opinion'],
  ['not_ready', 'Not ready yet'], ['no_need', 'Does not feel it is needed'], ['other', 'Other'],
] as const;
