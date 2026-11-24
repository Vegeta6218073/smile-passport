import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWebhook, verifySignature } from './meta';

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
      ],
    } }] }],
  };
  it('extracts statuses and messages and skips junk', () => {
    const r = parseWebhook(payload);
    expect(r.statuses.map((s) => s.status)).toEqual(['delivered', 'failed']);
    expect(r.statuses[1].error).toBe('Undeliverable');
    expect(r.inbound.map((m) => m.body)).toEqual(['STOP', '[non-text message]']);
  });
  it('survives garbage', () => {
    expect(parseWebhook(null)).toEqual({ statuses: [], inbound: [] });
    expect(parseWebhook({ entry: 'x' })).toEqual({ statuses: [], inbound: [] });
    expect(parseWebhook({ entry: [{ changes: [{}] }] })).toEqual({ statuses: [], inbound: [] });
  });
});
