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
export type ParsedInbound = {
  from: string; body: string; providerId: string; at: string;
  media?: { id: string; mimeType: string | null };   // images only (patient photos, roadmap #34)
};

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
        const image = m.type === 'image' && typeof m.image?.id === 'string' ? m.image : null;
        inbound.push({
          from: m.from,
          providerId: m.id,
          body: m.type === 'text' && typeof m.text?.body === 'string' ? m.text.body
            : image ? String(image.caption ?? '').slice(0, 500) : '[non-text message]',
          at: isoFromUnix(m.timestamp),
          ...(image ? { media: { id: image.id, mimeType: typeof image.mime_type === 'string' ? image.mime_type : null } } : {}),
        });
      }
    }
  }
  return { statuses, inbound };
}

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

// Downloads a patient photo from the Cloud API: first the media URL, then the bytes (both need the token).
export async function downloadMedia(
  mediaId: string,
  { accessToken, apiVersion = 'v21.0', fetchImpl = fetch }: { accessToken: string; apiVersion?: string; fetchImpl?: typeof fetch },
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(mediaId)) throw new Error('invalid media id');
  const meta = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number };
  if (!meta.ok || !info.url) throw new Error(`media lookup failed (${meta.status})`);
  if (!/^https:\/\/[a-z0-9.-]+\.(fbsbx|facebook|whatsapp)\.(com|net)\//i.test(info.url)) throw new Error('unexpected media host');
  if ((info.file_size ?? 0) > MAX_MEDIA_BYTES) throw new Error('media too large');
  const file = await fetchImpl(info.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!file.ok) throw new Error(`media download failed (${file.status})`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error('media too large');
  return { bytes, mimeType: info.mime_type ?? 'application/octet-stream' };
}
