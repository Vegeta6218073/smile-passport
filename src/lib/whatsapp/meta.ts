import { createHmac, timingSafeEqual } from 'node:crypto';

// Meta signs every webhook with HMAC-SHA256 of the raw body, using the app secret.
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=') || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export type ParsedStatus = {
  providerId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  at: string;
  error?: string;
};
export type ParsedInbound = { from: string; body: string; providerId: string; at: string };

const isoFromUnix = (s: unknown) => {
  const n = Number(s);
  return new Date((Number.isFinite(n) && n > 0 ? n : Date.now() / 1000) * 1000).toISOString();
};

// Defensive on purpose: webhook bodies come from the network, so anything unexpected is skipped.
export function parseWebhook(payload: unknown): { statuses: ParsedStatus[]; inbound: ParsedInbound[] } {
  const statuses: ParsedStatus[] = [];
  const inbound: ParsedInbound[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return { statuses, inbound };

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value ?? {};
      for (const s of (Array.isArray(value.statuses) ? value.statuses : []) as Record<string, any>[]) {
        if (typeof s?.id !== 'string' || !['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
        statuses.push({
          providerId: s.id,
          status: s.status,
          at: isoFromUnix(s.timestamp),
          error: s.status === 'failed' ? String(s.errors?.[0]?.title ?? 'delivery failed') : undefined,
        });
      }
      for (const m of (Array.isArray(value.messages) ? value.messages : []) as Record<string, any>[]) {
        if (typeof m?.id !== 'string' || typeof m?.from !== 'string') continue;
        inbound.push({
          from: m.from,
          providerId: m.id,
          body: m.type === 'text' && typeof m.text?.body === 'string' ? m.text.body : '[non-text message]',
          at: isoFromUnix(m.timestamp),
        });
      }
    }
  }
  return { statuses, inbound };
}
