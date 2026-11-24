import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import PrintButton from './PrintButton';

export const dynamic = 'force-dynamic';

// Printable Smile Report. Lives outside the (app) shell so printing has no navigation.
// Sign-in is still required: reports are shared by staff as a PDF, never by public link.
export default async function ReportPage({ params }: { params: { id: string } }) {
  const member = await requirePermission('scan:view');
  const supabase = createClient();

  const { data: scan } = await supabase.from('smile_scans').select('*').eq('id', params.id).maybeSingle();
  if (!scan || !scan.report_observations) notFound();

  const [{ data: clinic }, { data: reviewer }] = await Promise.all([
    supabase.from('clinics').select('name').eq('id', member.clinicId).single(),
    scan.reviewer_id
      ? supabase.from('clinic_members').select('display_name').eq('user_id', scan.reviewer_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const section = (title: string, body?: string | null) =>
    body ? (
      <section>
        <h2>{title}</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{body}</p>
      </section>
    ) : null;

  return (
    <main className="shell" style={{ maxWidth: 720 }}>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>
      <PrintButton />
      <h1>Your Smile Report</h1>
      <p className="muted">
        {clinic?.name} · prepared for {scan.full_name} · {dateIn(scan.report_ready_at ?? scan.submitted_at, member.timezone)}
      </p>
      {section('Smile observations', scan.report_observations)}
      {section('Areas that may benefit from evaluation', scan.report_areas)}
      {section('Possible treatment options', scan.report_options)}
      {section('Estimated treatment duration', scan.report_duration)}
      {section('Next steps', scan.report_next_steps)}
      <p className="muted">Reviewed by {reviewer?.display_name ?? 'the reviewing orthodontist'}.</p>
      <p className="muted">
        This report is a screening review based on photographs and is not a medical diagnosis.
        A full clinical examination is needed before any treatment is recommended.
      </p>
    </main>
  );
}
