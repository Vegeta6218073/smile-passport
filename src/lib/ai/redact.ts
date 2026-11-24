// Identifier minimisation (AI guardrail): remove what identifies a person before a prompt
// leaves S-One. Names we know are replaced; phone numbers, emails and long numbers always are.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text: string, knownNames: (string | null | undefined)[] = []): string {
  let out = String(text ?? '');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  out = out.replace(/\+?\d[\d\s-]{7,}\d/g, '[number]');
  const parts = knownNames
    .flatMap((n) => String(n ?? '').split(/\s+/))
    .map((p) => p.trim())
    .filter((p) => p.length >= 3);
  for (const p of [...new Set(parts)].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(^|[^\\p{L}])${escape(p)}(?=$|[^\\p{L}])`, 'giu'), '$1[name]');
  }
  return out;
}

// After the provider call: put the first name back into the draft for the staff member to send.
export function fillName(draft: string, fullName: string | null | undefined): string {
  const first = String(fullName ?? '').trim().split(/\s+/)[0] || 'there';
  return draft.replace(/\{\{name\}\}/g, first);
}
