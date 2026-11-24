import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { captureError } from '@/lib/monitoring';
import { STATUS_LABEL } from '@/lib/scan';
import { toCsv } from '@/lib/funnel';
import { todayIn } from '@/lib/dates';

export const dynamic = 'force-dynamic';

// Stage 7 of the plan: a CRM spreadsheet with name, country, photos received, report sent,
// consultation booked and treatment accepted. Owner and coordinator only (it holds contact details),
// read through the signed-in client so row-level security still applies.
export async function GET() {
  const member = await requirePermission('funnel:view');
  const { data, error } = await createClient()
    .from('smile_scans')
    .select(`full_name, phone, email, city, country, source, submitted_at, status, route,
             report_sent_at, consult_booked_at, treatment_started_at, fee_inr, payment_status,
             feedback_would_recommend, smile_scan_photos(count)`)
    .order('submitted_at', { ascending: false })
    .limit(5000);
  if (error) {
    captureError(error, { route: 'scans/export' });
    return new NextResponse('Could not export scans.', { status: 500 });
  }

  const tz = member.timezone;
  const day = (iso: string | null) => (iso ? todayIn(tz, new Date(iso)) : '');
  const yesNo = (v: boolean | null) => (v === true ? 'yes' : v === false ? 'no' : '');

  const rows = (data ?? []).map((s) => {
    const photos = Array.isArray(s.smile_scan_photos) ? (s.smile_scan_photos[0] as { count?: number })?.count ?? 0 : 0;
    return [
      s.full_name, s.phone, s.email, s.city, s.country, s.source, day(s.submitted_at), photos,
      STATUS_LABEL[s.status] ?? s.status, s.route === 'home_clinic' ? 'home clinic' : 'referral',
      day(s.report_sent_at), day(s.consult_booked_at), day(s.treatment_started_at),
      s.fee_inr || '', s.fee_inr ? s.payment_status : '', yesNo(s.feedback_would_recommend),
    ];
  });

  const csv = toCsv(
    ['Name', 'Phone', 'Email', 'City', 'Country', 'Source', 'Submitted', 'Photos received', 'Status', 'Route',
     'Report sent', 'Consultation booked', 'Treatment accepted', 'Review fee (INR)', 'Payment', 'Would recommend'],
    rows,
  );
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="smile-scans-${todayIn(tz)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
