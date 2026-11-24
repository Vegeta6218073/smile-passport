import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { captureError } from '@/lib/monitoring';
import { parseWebhook, verifySignature } from '@/lib/whatsapp/meta';

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
  for (const m of inbound) {
    const { error } = await admin.rpc('record_inbound_message', {
      p_clinic: clinicId, p_phone: m.from, p_body: m.body, p_provider_id: m.providerId,
    });
    if (error) { failed = true; captureError(error, { route: 'whatsapp/webhook', step: 'inbound' }); }
  }

  // A 500 makes Meta retry later; the database ignores duplicates, so retries are safe.
  return new NextResponse(failed ? 'error' : 'ok', { status: failed ? 500 : 200 });
}
