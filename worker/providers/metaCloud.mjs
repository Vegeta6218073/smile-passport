import { toE164Digits } from '../templates.mjs';

// WhatsApp Business Cloud API adapter (Meta). NOT yet verified against live credentials:
// test with a sandbox number before using it for patients. See docs/automation.md.

export function buildTemplatePayload({ to, templateName, language, params }) {
  return {
    messaging_product: 'whatsapp',
    to: toE164Digits(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components: params.length
        ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }]
        : [],
    },
  };
}

export function createMetaCloudProvider({ phoneNumberId, accessToken, apiVersion = 'v21.0', fetchImpl = fetch }) {
  if (!phoneNumberId || !accessToken) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required for meta_cloud');
  }
  return {
    name: 'meta_cloud',
    async send(message) {
      const res = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTemplatePayload(message)),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`WhatsApp send failed (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
        // Rate limits and server errors are worth retrying; other 4xx (bad number, template problem) are not.
        err.retry = res.status === 429 || res.status >= 500;
        throw err;
      }
      const providerMessageId = body?.messages?.[0]?.id;
      if (!providerMessageId) throw Object.assign(new Error('WhatsApp accepted the message but returned no id'), { retry: false });
      return { providerMessageId };
    },
  };
}
