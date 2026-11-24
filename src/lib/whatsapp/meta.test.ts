import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { downloadMedia, parseWebhook, verifySignature } from './meta';

const sign = (body: string, secret: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifySignature', () => {
  const body = '{"a":1}';
  it('accepts a correct signature', () => {
    expect(verifySignature(body, sign(body, 's3cret'), 's3cret')).toBe(true);
  });
  it('rejects wrong, missing or malformed signatures', () => {
    expect(verifySignature(body, sign(body, 'other'), 's3cret')).toBe(false);
    expect(verifySignature(body, null, 's3cret')).toBe(false);
    expect(verifySignature(body, 'sha256=abc', 's3cret')).toBe(false);
    expect(verifySignature(body, sign(body, 's3cret'), '')).toBe(false);
  });
  it('rejects a body that was changed after signing', () => {
    expect(verifySignature('{"a":2}', sign(body, 's3cret'), 's3cret')).toBe(false);
  });
});

describe('parseWebhook', () => {
  const payload = {
    entry: [{ changes: [{ value: {
      statuses: [
        { id: 'wamid.1', status: 'delivered', timestamp: '1764000000' },
        { id: 'wamid.2', status: 'failed', timestamp: '1764000001', errors: [{ title: 'Undeliverable' }] },
        { id: 'wamid.3', status: 'weird' },
      ],
      messages: [
        { id: 'wamid.in1', from: '919876543210', type: 'text', text: { body: 'STOP' }, timestamp: '1764000002' },
        { id: 'wamid.in2', from: '919876543210', type: 'image' },
        { id: 'wamid.in3', from: '919876543210', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'my wire' } },
      ],
    } }] }],
  };
  it('extracts statuses and messages and skips junk', () => {
    const r = parseWebhook(payload);
    expect(r.statuses.map((s) => s.status)).toEqual(['delivered', 'failed']);
    expect(r.statuses[1].error).toBe('Undeliverable');
    expect(r.inbound.map((m) => m.body)).toEqual(['STOP', '[non-text message]', 'my wire']);
    expect(r.inbound[2].media).toEqual({ id: 'MEDIA1', mimeType: 'image/jpeg' });
    expect(r.inbound[1].media).toBeUndefined();
  });
  it('survives garbage', () => {
    expect(parseWebhook(null)).toEqual({ statuses: [], inbound: [] });
    expect(parseWebhook({ entry: 'x' })).toEqual({ statuses: [], inbound: [] });
    expect(parseWebhook({ entry: [{ changes: [{}] }] })).toEqual({ statuses: [], inbound: [] });
  });
});

describe('downloadMedia', () => {
  const ok = (body: unknown, bytes?: Uint8Array) => ({
    ok: true, status: 200, json: async () => body, arrayBuffer: async () => (bytes ?? new Uint8Array()).buffer,
  }) as unknown as Response;
  it('fetches the URL then the bytes, with the token', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? ok({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg', file_size: 3 })
        : ok(null, new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const r = await downloadMedia('MEDIA1', { accessToken: 't', fetchImpl });
    expect(r.bytes.length).toBe(3);
    expect(calls[0]).toContain('/MEDIA1');
  });
  it('refuses unexpected hosts and bad ids', async () => {
    const fetchImpl = (async () => ok({ url: 'https://evil.example.com/x' })) as unknown as typeof fetch;
    await expect(downloadMedia('MEDIA1', { accessToken: 't', fetchImpl })).rejects.toThrow('unexpected media host');
    await expect(downloadMedia('../x', { accessToken: 't', fetchImpl })).rejects.toThrow('invalid media id');
  });
});
