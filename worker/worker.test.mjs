import { describe, expect, it } from 'vitest';
import { maskPhone, messageParams, renderBody, reminderParams, toE164Digits } from './templates.mjs';
import { buildTemplatePayload, createMetaCloudProvider } from './providers/metaCloud.mjs';
import { getProvider } from './providers/index.mjs';
import { pushConfigured, pushPayload, sendPushes } from './push.mjs';

describe('templates', () => {
  it('builds reminder parameters in the clinic time zone', () => {
    const p = reminderParams({
      patientName: 'Asha Rao', clinicName: 'Dev Clinic',
      startsAt: '2026-11-25T05:00:00Z', timeZone: 'Asia/Kolkata',
    });
    expect(p[0]).toBe('Asha');
    expect(p[1]).toBe('Dev Clinic');
    expect(p[3].toLowerCase()).toContain('10:30');
  });
  it('builds parameters for messages without an appointment', () => {
    expect(messageParams({ kind: 'payment_reminder', patientName: 'Asha Rao', clinicName: 'C', extra: ['₹5,000', '01 Dec 2026'] }))
      .toEqual(['Asha', 'C', '₹5,000', '01 Dec 2026']);
    expect(messageParams({ kind: 'comfort_checkin', patientName: '', clinicName: 'C', extra: null })).toEqual(['there', 'C']);
  });
  it('fills placeholders and leaves nothing behind', () => {
    expect(renderBody('Hi {{1}}, see you at {{4}}', ['Asha', 'X', 'Y', '10:30 am'])).toBe('Hi Asha, see you at 10:30 am');
    expect(renderBody('Hi {{3}}', ['a'])).toBe('Hi ');
  });
  it('masks phones and normalises numbers', () => {
    expect(maskPhone('+91 98765 43210')).toBe('********3210');
    expect(toE164Digits('98765 43210')).toBe('919876543210');
    expect(toE164Digits('098765 43210')).toBe('919876543210');
    expect(toE164Digits('+971 50 123 4567')).toBe('971501234567');
  });
});

describe('meta cloud provider', () => {
  it('builds a template payload', () => {
    const body = buildTemplatePayload({ to: '9876543210', templateName: 'appt', language: 'en', params: ['Asha', 'Clinic'] });
    expect(body.to).toBe('919876543210');
    expect(body.template.components[0].parameters).toEqual([{ type: 'text', text: 'Asha' }, { type: 'text', text: 'Clinic' }]);
  });
  const make = (status, json) =>
    createMetaCloudProvider({
      phoneNumberId: '1', accessToken: 't',
      fetchImpl: async () => ({ ok: status < 300, status, json: async () => json }),
    });
  const msg = { id: 'm1', to: '9876543210', templateName: 't', language: 'en', params: [] };

  it('returns the provider message id', async () => {
    expect(await make(200, { messages: [{ id: 'wamid.X' }] }).send(msg)).toEqual({ providerMessageId: 'wamid.X' });
  });
  it('retries rate limits and server errors, not bad requests', async () => {
    await expect(make(429, { error: { message: 'slow down' } }).send(msg)).rejects.toMatchObject({ retry: true });
    await expect(make(503, {}).send(msg)).rejects.toMatchObject({ retry: true });
    await expect(make(400, { error: { message: 'bad number' } }).send(msg)).rejects.toMatchObject({ retry: false });
  });
  it('needs credentials', () => {
    expect(() => createMetaCloudProvider({})).toThrow();
  });
});

describe('getProvider', () => {
  it('defaults to the dry run provider', () => {
    expect(getProvider({}).name).toBe('dry_run');
  });
  it('rejects unknown providers', () => {
    expect(() => getProvider({ WHATSAPP_PROVIDER: 'carrier-pigeon' })).toThrow();
  });
});

describe('push notifications', () => {
  it('never puts patient details in the payload', () => {
    const p = JSON.parse(pushPayload({ kind: 'concern', urgent: true, link: '/concerns', title: 'Urgent concern: Asha Rao' }));
    expect(p.title).toBe('URGENT patient concern');
    expect(JSON.stringify(p)).not.toContain('Asha');
    expect(JSON.parse(pushPayload({ kind: 'task', link: 'https://evil' })).url).toBe('/today');
  });
  it('does nothing without VAPID keys', async () => {
    expect(pushConfigured({})).toBe(false);
    expect(await sendPushes({ admin: null, env: {} })).toEqual({ pushed: 0, skipped: 'no VAPID keys' });
  });
  it('sends to each device and drops dead subscriptions', async () => {
    const deleted = [], updated = [], sent = [];
    const admin = {
      from(table) {
        const q = {
          select: () => q, is: () => q, gte: () => q, limit: async () => ({ data: [{ id: 'n1', user_id: 'u', kind: 'task', link: '/tasks' }] }),
          eq: async (col, v) => (table === 'push_subscriptions' && col === 'user_id'
            ? { data: [{ id: 's1', endpoint: 'https://a', p256dh: 'k', auth: 'a' }, { id: 's2', endpoint: 'https://b', p256dh: 'k', auth: 'a' }] }
            : (table === 'push_subscriptions' ? deleted.push(v) : updated.push(v), {})),
          delete: () => q, update: () => q,
        };
        return q;
      },
    };
    const client = {
      setVapidDetails() {},
      async sendNotification(sub) { if (sub.endpoint === 'https://b') throw Object.assign(new Error('gone'), { statusCode: 410 }); sent.push(sub.endpoint); },
    };
    const r = await sendPushes({ admin, env: { VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:x' }, client, log: () => {} });
    expect(r.pushed).toBe(1);
    expect(sent).toEqual(['https://a']);
    expect(deleted).toEqual(['s2']);
    expect(updated).toEqual(['n1']);
  });
});
