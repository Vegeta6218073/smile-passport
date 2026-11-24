// Background worker. Run once (for a scheduler) or with --loop (always on).
//   npm run worker          one pass, then exit
//   npm run worker:loop     a pass every 60 seconds
// Each pass: queue due reminders, raise scan deadline alerts, then send what is queued.
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { getProvider } from './providers/index.mjs';
import { reminderParams } from './templates.mjs';

async function count(admin, fn) {
  const { data, error } = await admin.rpc(fn);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data ?? 0;
}

// Re-reads everything fresh, including opt-in, right before sending.
async function loadContext(admin, message) {
  const [{ data: patient }, { data: appt }, { data: template }, { data: clinic }] = await Promise.all([
    admin.from('patients').select('full_name, phone, whatsapp_opt_in').eq('id', message.patient_id).single(),
    admin.from('appointments').select('starts_at').eq('id', message.appointment_id).maybeSingle(),
    admin.from('message_templates').select('provider_template_name, language, approved').eq('id', message.template_id).single(),
    admin.from('clinics').select('name, timezone').eq('id', message.clinic_id).single(),
  ]);
  if (!patient || !template || !clinic) return { ok: false, reason: 'missing patient, template or clinic' };
  if (!patient.whatsapp_opt_in) return { ok: false, blocked: true };
  if (!template.approved || !template.provider_template_name) return { ok: false, reason: 'template is not approved' };
  if (!appt) return { ok: false, reason: 'appointment no longer exists' };
  return {
    ok: true,
    phone: patient.phone,
    template,
    params: reminderParams({
      patientName: patient.full_name, clinicName: clinic.name, startsAt: appt.starts_at, timeZone: clinic.timezone,
    }),
  };
}

export async function runOnce({ admin, provider, log = console.log }) {
  const reminders = await count(admin, 'enqueue_appointment_reminders');
  const alerts = await count(admin, 'enqueue_scan_deadline_alerts');

  const { data: batch, error } = await admin.rpc('claim_outbound_batch', { p_limit: 20 });
  if (error) throw new Error(`claim_outbound_batch: ${error.message}`);

  const result = { reminders, alerts, sent: 0, failed: 0, blocked: 0 };
  for (const message of batch ?? []) {
    try {
      const ctx = await loadContext(admin, message);
      if (!ctx.ok && ctx.blocked) {
        await admin.from('outbound_messages').update({ status: 'blocked_no_opt_in', locked_at: null })
          .eq('id', message.id).eq('status', 'queued');
        result.blocked += 1;
        continue;
      }
      if (!ctx.ok) {
        await admin.rpc('mark_outbound_failed', { p_id: message.id, p_error: ctx.reason, p_retry: false });
        result.failed += 1;
        continue;
      }
      const sent = await provider.send({
        id: message.id, to: ctx.phone, templateName: ctx.template.provider_template_name,
        language: ctx.template.language, params: ctx.params,
      });
      const { data: status } = await admin.rpc('mark_outbound_sent', {
        p_id: message.id, p_provider_id: sent.providerMessageId,
      });
      if (status === 'blocked_no_opt_in') result.blocked += 1; else result.sent += 1;
    } catch (err) {
      await admin.rpc('mark_outbound_failed', {
        p_id: message.id, p_error: String(err?.message ?? err), p_retry: err?.retry !== false,
      });
      result.failed += 1;
    }
  }
  log(`[worker] ${JSON.stringify(result)}`);
  return result;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const provider = getProvider();
  console.log(`[worker] provider: ${provider.name}`);

  const loop = process.argv.includes('--loop');
  do {
    try {
      await runOnce({ admin, provider });
    } catch (err) {
      console.error('[worker] pass failed:', err);
      if (!loop) process.exitCode = 1;
    }
    if (loop) await new Promise((r) => setTimeout(r, 60_000));
  } while (loop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
