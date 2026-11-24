import { describe, expect, it } from 'vitest';
import { maskPhone, renderBody, reminderParams, toE164Digits } from './templates.mjs';
import { buildTemplatePayload, createMetaCloudProvider } from './providers/metaCloud.mjs';
import { getProvider } from './providers/index.mjs';

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
