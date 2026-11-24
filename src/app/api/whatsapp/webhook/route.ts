import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { captureError } from '@/lib/monitoring';
import { downloadMedia, parseWebhook, verifySignature } from '@/lib/whatsapp/meta';
import { detectImageType, CONTENT_TYPE, EXTENSION } from '@/lib/scan';
import { featureOn, getAiProvider, loadSwitches } from '@/lib/ai/gateway';
import { redact } from '@/lib/ai/redact';

export const runtime = 'nodejs';

// Meta calls GET once when you register the webhook, to prove you own it.
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (token && q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === token) {
    return new NextResponse(q.get('hub.challenge') ?? '', { status: 200 });
  }
  return new NextResponse('forbidden', { status: 403 });
}

// Delivery receipts and patient replies. Unsigned or wrongly signed requests are refused.
export async function POST(request: NextRequest) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  const clinicId = process.env.WHATSAPP_CLINIC_ID ?? process.env.SMILE_PASSPORT_CLINIC_ID;
  if (!secret || !clinicId) return new NextResponse('not configured', { status: 503 });

  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get('x-hub-signature-256'), secret)) {
    return new NextResponse('invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse('bad json', { status: 400 });
  }

  const { statuses, inbound } = parseWebhook(payload);
  const admin = createAdminClient();
  let failed = false;

  for (const s of statuses) {
    const { error } = await admin.rpc('record_delivery_status', {
      p_provider_id: s.providerId, p_status: s.status, p_at: s.at, p_error: s.error ?? null,
    });
    if (error) { failed = true; captureError(error, { route: 'whatsapp/webhook', step: 'status' }); }
  }
  const switches = inbound.length ? await loadSwitches(admin, clinicId) : null;
  for (const m of inbound) {
    const { data, error } = await admin.rpc('record_inbound_message', {
      p_clinic: clinicId, p_phone: m.from, p_body: m.body, p_provider_id: m.providerId,
      p_media_id: m.media?.id ?? null, p_media_type: m.media?.mimeType ?? null,
    });
    if (error) { failed = true; captureError(error, { route: 'whatsapp/webhook', step: 'inbound' }); continue; }
    const row = (data as { result: string; inbound_id: string | null; patient_id: string | null }[] | null)?.[0];
    if (row?.result === 'photo' && row.inbound_id && row.patient_id && m.media) {
      await storePhoto(admin, clinicId, row.inbound_id, row.patient_id, m.media.id);
      continue;
    }
    if (!row?.inbound_id || !row.patient_id || !['checkin_reply', 'reply'].includes(row.result)) continue;

    // #19: sort the reply by urgency. With the feature off, check-in replies go to a person as "unclear".
    try {
      let label = 'unknown', topic: string | null = null, confidence = 0, model = 'none (classification off)';
      if (featureOn(switches, 'checkin_classification')) {
        const { data: p } = await admin.from('patients').select('full_name').eq('id', row.patient_id).maybeSingle();
        const provider = getAiProvider();
        const c = await provider.classifyReply(redact(m.body, [p?.full_name]));
        ({ label, topic, confidence } = c);
        model = provider.name;
      } else if (row.result !== 'checkin_reply') {
        continue;
      }
      const { error: cErr } = await admin.rpc('apply_reply_classification', {
        p_inbound: row.inbound_id, p_label: label, p_topic: topic, p_confidence: confidence, p_model: model,
      });
      if (cErr) throw cErr;
    } catch (err) {
      // Never lose a reply: if classification fails, a clinician reads it.
      captureError(err, { route: 'whatsapp/webhook', step: 'classify' });
      await admin.rpc('apply_reply_classification', {
        p_inbound: row.inbound_id, p_label: 'unknown', p_topic: null, p_confidence: 0, p_model: 'error-fallback',
      });
    }
  }

  // A 500 makes Meta retry later; the database ignores duplicates, so retries are safe.
  return new NextResponse(failed ? 'error' : 'ok', { status: failed ? 500 : 200 });
}

// #34: a patient photo is stored only with photo consent; otherwise staff are asked to get consent.
async function storePhoto(
  admin: ReturnType<typeof createAdminClient>, clinicId: string, inboundId: string, patientId: string, mediaId: string,
) {
  try {
    const { data: consent } = await admin.rpc('has_photo_consent', { p_patient: patientId });
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!consent || !token) {
      await admin.rpc('handle_whatsapp_photo', { p_inbound: inboundId, p_path: null });
      return;
    }
    const { bytes } = await downloadMedia(mediaId, { accessToken: token, apiVersion: process.env.WHATSAPP_API_VERSION });
    const type = detectImageType(bytes);
    if (!type) throw new Error('not an image');
    const path = `${clinicId}/patients/${patientId}/whatsapp-${inboundId}.${EXTENSION[type]}`;
    const { error: upErr } = await admin.storage.from('clinic-files').upload(path, bytes, { contentType: CONTENT_TYPE[type], upsert: true });
    if (upErr) throw upErr;
    const { error } = await admin.rpc('handle_whatsapp_photo', {
      p_inbound: inboundId, p_path: path, p_content_type: CONTENT_TYPE[type], p_bytes: bytes.length,
    });
    if (error) throw error;
  } catch (err) {
    captureError(err, { route: 'whatsapp/webhook', step: 'photo' });
    await admin.from('tasks').insert({
      clinic_id: clinicId, patient_id: patientId, source: 'system', due_at: new Date().toISOString(),
      title: 'A patient photo from WhatsApp could not be saved: ask them to resend it',
    });
  }
}
