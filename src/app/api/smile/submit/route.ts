import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { captureError } from '@/lib/monitoring';
import {
  CONTENT_TYPE, EXTENSION, MAX_PHOTO_BYTES, MAX_SCANS_PER_PHONE_PER_DAY, PHOTO_KINDS,
  REQUIRED_PHOTOS, SCAN_CONSENT_VERSION, detectImageType, scanSubmitSchema, type PhotoKind,
} from '@/lib/scan';

export const runtime = 'nodejs';

// Best-effort per-IP limit. Serverless instances do not share memory, so the real
// protection is the per-phone limit in the database plus the size and type checks below.
const hits = new Map<string, { count: number; reset: number }>();
function allowIp(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.reset < now) {
    hits.set(ip, { count: 1, reset: now + 60 * 60 * 1000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

function back(request: NextRequest, message: string) {
  const url = new URL('/smile/scan', request.url);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const clinicId = process.env.SMILE_PASSPORT_CLINIC_ID;
  if (!clinicId) return back(request, 'Smile scans are not open yet. Please try again soon.');

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!allowIp(ip)) return back(request, 'Too many attempts. Please try again in an hour.');

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > 4 * MAX_PHOTO_BYTES) return back(request, 'Those photos are too large. Each must be under 8 MB.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(request, 'We could not read that form. Please try again.');
  }

  const parsed = scanSubmitSchema.safeParse(Object.fromEntries(
    [...form.entries()].filter(([, v]) => typeof v === 'string'),
  ));
  if (!parsed.success) return back(request, parsed.error.issues[0].message);
  const v = parsed.data;

  // Validate every photo before anything is stored.
  const photos: { kind: PhotoKind; bytes: Uint8Array; type: 'jpeg' | 'png' | 'webp' }[] = [];
  for (const kind of PHOTO_KINDS) {
    const file = form.get(kind);
    if (!(file instanceof File) || file.size === 0) {
      if (REQUIRED_PHOTOS.includes(kind)) return back(request, 'Please add the front smiling photo and the front teeth photo.');
      continue;
    }
    if (file.size > MAX_PHOTO_BYTES) return back(request, 'Each photo must be under 8 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = detectImageType(bytes);
    if (!type) return back(request, 'Photos must be JPEG, PNG or WebP images.');
    photos.push({ kind, bytes, type });
  }

  const admin = createAdminClient();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin.from('smile_scans').select('id', { count: 'exact', head: true })
    .eq('clinic_id', clinicId).eq('phone', v.phone).gte('submitted_at', since);
  if ((count ?? 0) >= MAX_SCANS_PER_PHONE_PER_DAY) {
    return back(request, 'We already have your scans from today. Our orthodontist will be in touch.');
  }

  const { data: scan, error } = await admin.from('smile_scans').insert({
    clinic_id: clinicId,
    full_name: v.full_name,
    phone: v.phone,
    email: v.email ?? null,
    city: v.city,
    country: v.country,
    main_concern: v.main_concern ?? null,
    source: v.source ?? null,
    consent_data: true,
    consent_whatsapp: v.consent_whatsapp,
    consent_text_version: SCAN_CONSENT_VERSION,
  }).select('id').single();
  if (error || !scan) {
    captureError(error, { route: 'smile/submit' });
    return back(request, 'Something went wrong. Nothing was saved. Please try again.');
  }

  const uploaded: string[] = [];
  let failed = false;
  for (const p of photos) {
    const path = `${clinicId}/scans/${scan.id}/${p.kind}.${EXTENSION[p.type]}`;
    const { error: upErr } = await admin.storage.from('clinic-files')
      .upload(path, p.bytes, { contentType: CONTENT_TYPE[p.type], upsert: false });
    if (upErr) { failed = true; captureError(upErr, { route: 'smile/submit', step: 'upload' }); break; }
    uploaded.push(path);
    const { error: rowErr } = await admin.from('smile_scan_photos').insert({
      clinic_id: clinicId, scan_id: scan.id, kind: p.kind, storage_path: path,
      content_type: CONTENT_TYPE[p.type], bytes: p.bytes.length,
    });
    if (rowErr) { failed = true; captureError(rowErr, { route: 'smile/submit', step: 'photo-row' }); break; }
  }

  if (failed) {
    // Roll back so staff never see a scan with missing photos.
    if (uploaded.length) await admin.storage.from('clinic-files').remove(uploaded);
    await admin.from('smile_scans').delete().eq('id', scan.id);
    return back(request, 'We could not save your photos. Please try again.');
  }

  return NextResponse.redirect(new URL('/smile/thanks', request.url), 303);
}
