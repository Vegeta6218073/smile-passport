import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { PHOTO_LABELS, STATUS_LABEL, waLink, type PhotoKind } from '@/lib/scan';
import { dateIn } from '@/lib/dates';
import {
  assignPartner, claimScan, convertToPatient, markConsultBooked, markReportSent,
  markTreatmentStarted, requestBetterPhotos, saveReport, setPayment,
} from '../actions';

export const dynamic = 'force-dynamic';

export default async function ScanPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { error?: string; ok?: string };
}) {
  const member = await requirePermission('scan:view');
  const supabase = createClient();

  const { data: scan } = await supabase.from('smile_scans').select('*').eq('id', params.id).maybeSingle();
  if (!scan) notFound();

  const [{ data: photos }, { data: partners }, { data: clinic }] = await Promise.all([
    supabase.from('smile_scan_photos').select('kind, storage_path').eq('scan_id', scan.id),
    scan.route === 'referral'
      ? supabase.from('referral_partners').select('id, name, city, phone').eq('active', true).order('name')
      : Promise.resolve({ data: [] }),
    supabase.from('clinics').select('name, booking_url').eq('id', member.clinicId).single(),
  ]);

  // Private bucket: photos are shown through short-lived signed links (10 minutes).
  const paths = photos?.map((p) => p.storage_path) ?? [];
  const { data: signed } = paths.length
    ? await supabase.storage.from('clinic-files').createSignedUrls(paths, 600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlFor = (path: string) => signed?.find((s) => s.path === path)?.signedUrl;

  const canReport = can(member.role, 'scan:report');
  const tz = member.timezone;
  const partner = partners?.find((p) => p.id === scan.referral_partner_id);
  const reportText = `Hi ${scan.full_name.split(' ')[0]}, your Smile Report from ${clinic?.name ?? 'our clinic'} is ready.`;
  const editing = canReport && ['in_review', 'report_ready'].includes(scan.status);

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>{scan.full_name} <span className="muted">({STATUS_LABEL[scan.status] ?? scan.status})</span></h2>
        <p className="muted">
          {scan.phone}{scan.email ? ` · ${scan.email}` : ''} · {scan.city}, {scan.country} · submitted {dateIn(scan.submitted_at, tz)}
        </p>
        {scan.main_concern && <p>“{scan.main_concern}”</p>}
        <p className="muted">
          Route: {scan.route === 'home_clinic' ? 'book with the home clinic' : 'refer to a partner'}
          {scan.fee_inr > 0 && ` · review fee ₹${scan.fee_inr} (${scan.payment_status})`}
        </p>
        {scan.fee_inr > 0 && (
          <form action={setPayment}>
            <input type="hidden" name="scan_id" value={scan.id} />
            <button name="status" value={scan.payment_status === 'paid' ? 'pending' : 'paid'} type="submit" className="link">
              {scan.payment_status === 'paid' ? 'Mark as unpaid' : 'Mark fee as paid'}
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <h2>Photos</h2>
        {photos?.length === 0 && <p className="muted">No photos found.</p>}
        {photos?.map((p) => {
          const url = urlFor(p.storage_path);
          return (
            <figure key={p.kind}>
              <figcaption>{PHOTO_LABELS[p.kind as PhotoKind]}</figcaption>
              {url ? <img src={url} alt={PHOTO_LABELS[p.kind as PhotoKind]} style={{ maxWidth: '100%' }} /> : <p className="error">Could not load this photo.</p>}
            </figure>
          );
        })}
        {canReport && ['submitted', 'needs_better_photos'].includes(scan.status) && (
          <form action={claimScan}>
            <input type="hidden" name="scan_id" value={scan.id} />
            <button type="submit">Start review</button>
          </form>
        )}
        {['submitted', 'in_review'].includes(scan.status) && (
          <form action={requestBetterPhotos}>
            <input type="hidden" name="scan_id" value={scan.id} />
            <input name="note" placeholder="What is wrong with the photos?" aria-label="Photo problem" required />
            <button type="submit" className="link">Ask for better photos</button>
          </form>
        )}
      </div>

      {(editing || scan.report_observations) && (
        <div className="card">
          <h2>Smile Report</h2>
          {editing ? (
            <form action={saveReport}>
              <input type="hidden" name="scan_id" value={scan.id} />
              <label htmlFor="observations">Smile observations</label>
              <textarea id="observations" name="observations" rows={4} defaultValue={scan.report_observations ?? ''} required />
              <label htmlFor="areas">Areas that may benefit from evaluation</label>
              <textarea id="areas" name="areas" rows={3} defaultValue={scan.report_areas ?? ''} />
              <label htmlFor="options">Possible treatment options</label>
              <textarea id="options" name="options" rows={3} defaultValue={scan.report_options ?? ''} />
              <label htmlFor="duration">Estimated treatment duration</label>
              <input id="duration" name="duration" defaultValue={scan.report_duration ?? ''} />
              <label htmlFor="next_steps">Next steps</label>
              <textarea id="next_steps" name="next_steps" rows={3} defaultValue={scan.report_next_steps ?? ''} required />
              <button type="submit">Save report</button>
            </form>
          ) : (
            <p className="muted">Saved by the reviewing doctor.</p>
          )}
          {scan.report_observations && (
            <p><Link href={`/report/${scan.id}`} target="_blank">Open printable report</Link></p>
          )}
        </div>
      )}

      <div className="card">
        <h2>Next step</h2>
        {scan.status === 'report_ready' && (
          <>
            <p className="muted">Share the report (print or save as PDF, then email or WhatsApp it), then mark it sent.</p>
            {scan.consent_whatsapp
              ? <p><a href={waLink(scan.phone, reportText)} target="_blank" rel="noopener noreferrer">Open WhatsApp chat</a></p>
              : <p className="muted">This person did not agree to WhatsApp. Use email or a phone call.</p>}
            <form action={markReportSent}>
              <input type="hidden" name="scan_id" value={scan.id} />
              <button type="submit">Mark report sent</button>
            </form>
          </>
        )}
        {scan.status === 'report_sent' && (
          <>
            {scan.route === 'home_clinic' ? (
              <p>Send this patient to book with the home clinic{clinic?.booking_url ? <>: <a href={clinic.booking_url} target="_blank" rel="noopener noreferrer">booking link</a></> : '.'}</p>
            ) : (
              <form action={assignPartner}>
                <input type="hidden" name="scan_id" value={scan.id} />
                <label htmlFor="partner_id">Refer to</label>
                <select id="partner_id" name="partner_id" defaultValue={scan.referral_partner_id ?? ''}>
                  <option value="">Choose a partner</option>
                  {partners?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.city ? ` (${p.city})` : ''}</option>)}
                </select>
                <button type="submit">Save</button>
                {partner?.phone && <p className="muted">Partner phone: {partner.phone}</p>}
              </form>
            )}
            <form action={markConsultBooked}>
              <input type="hidden" name="scan_id" value={scan.id} />
              <button type="submit">Consultation booked</button>
            </form>
          </>
        )}
        {scan.status === 'consult_booked' && (
          <form action={markTreatmentStarted}>
            <input type="hidden" name="scan_id" value={scan.id} />
            <button type="submit">Treatment started</button>
          </form>
        )}
        {['submitted', 'in_review', 'needs_better_photos'].includes(scan.status) && <p className="muted">Review the photos and write the report first.</p>}
        {scan.status === 'treatment_started' && <p>This patient started treatment.</p>}

        <form action={convertToPatient}>
          <input type="hidden" name="scan_id" value={scan.id} />
          <button type="submit" className="link">
            {scan.patient_id ? 'Open patient record' : 'Create patient record from this scan'}
          </button>
        </form>
      </div>
    </>
  );
}
