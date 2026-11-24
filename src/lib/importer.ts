// Patient import (roadmap #15): reads a CSV (Excel: File > Save As > CSV), maps the columns,
// and normalises values. The database re-checks every row and finds duplicates.
import { LANGUAGES, LEAD_SOURCES } from './constants';

export type ImportRow = {
  row: number;
  full_name: string;
  phone: string;
  email?: string;
  dob?: string;
  sex?: string;
  preferred_language?: string;
  guardian_name?: string;
  guardian_phone?: string;
  lead_source?: string;
  notes?: string;
};

export const MAX_IMPORT_ROWS = 5000;

// RFC 4180-style parser: quoted fields, doubled quotes, commas and new lines inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<keyof Omit<ImportRow, 'row'>, string[]> = {
  full_name: ['name', 'full name', 'patient name', 'patient'],
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'contact', 'contact number', 'whatsapp'],
  email: ['email', 'e-mail', 'email address'],
  dob: ['dob', 'date of birth', 'birth date', 'birthday'],
  sex: ['sex', 'gender'],
  preferred_language: ['language', 'preferred language'],
  guardian_name: ['guardian', 'guardian name', 'parent', 'parent name'],
  guardian_phone: ['guardian phone', 'parent phone', 'guardian mobile'],
  lead_source: ['source', 'lead source', 'how did you hear about us', 'referral source'],
  notes: ['notes', 'note', 'remarks', 'comments'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function mapHeaders(header: string[]): { map: Record<number, keyof Omit<ImportRow, 'row'>>; missing: string[] } {
  const map: Record<number, keyof Omit<ImportRow, 'row'>> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(n) && !Object.values(map).includes(key as keyof Omit<ImportRow, 'row'>)) {
        map[i] = key as keyof Omit<ImportRow, 'row'>;
        break;
      }
    }
  });
  const found = Object.values(map);
  const missing = (['full_name', 'phone'] as const).filter((k) => !found.includes(k));
  return { map, missing };
}

// 2026-01-31, 31/01/2026, 31-01-2026, 31.01.2026 -> 2026-01-31. Anything else is passed through
// so the database reports it as an error on that row.
export function normaliseDate(v: string): string {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

const SOURCE_BY_LABEL = new Map<string, string>(
  LEAD_SOURCES.flatMap(([v, l]) => [[norm(v), v], [norm(l), v]]),
);
const LANGUAGE_BY_LABEL = new Map<string, string>(
  LANGUAGES.flatMap(([v, l]) => [[norm(v), v], [norm(l), v]]),
);

export function toImportRows(text: string): { rows: ImportRow[]; problems: string[] } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], problems: ['The file has no data rows.'] };
  const { map, missing } = mapHeaders(table[0]);
  if (missing.length) {
    return { rows: [], problems: [`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ').replace('full_name', 'name')}.`] };
  }
  const problems: string[] = [];
  if (table.length - 1 > MAX_IMPORT_ROWS) problems.push(`Only the first ${MAX_IMPORT_ROWS} rows are read. Split the file.`);

  const rows = table.slice(1, MAX_IMPORT_ROWS + 1).map((cells, i) => {
    const r: ImportRow = { row: i + 2, full_name: '', phone: '' };
    for (const [idx, key] of Object.entries(map)) {
      const value = (cells[Number(idx)] ?? '').trim().slice(0, 500);
      if (!value) continue;
      if (key === 'dob') r.dob = normaliseDate(value);
      else if (key === 'lead_source') {
        const s = SOURCE_BY_LABEL.get(norm(value));
        if (s) r.lead_source = s;
        else r.notes = [r.notes, `Source: ${value}`].filter(Boolean).join('; ');
      } else if (key === 'preferred_language') r.preferred_language = LANGUAGE_BY_LABEL.get(norm(value)) ?? 'en';
      else if (key === 'notes') r.notes = [value, r.notes].filter(Boolean).join('; ');
      else r[key] = value;
    }
    return r;
  });
  return { rows, problems };
}
