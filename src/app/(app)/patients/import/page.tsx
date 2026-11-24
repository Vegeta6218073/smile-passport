import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import ImportForm from './ImportForm';

export const dynamic = 'force-dynamic';

// Roadmap #15: upload, validate, warn about duplicates, dry run, then import.
// Rehearse on a copy of the clinic's real list before go-live.
export default async function ImportPage() {
  const member = await requirePermission('patient:import');
  const { data: history } = await createClient().from('patient_imports')
    .select('id, file_name, dry_run, total_rows, imported, duplicates, errors, created_at')
    .order('created_at', { ascending: false }).limit(10);

  return (
    <>
      <div className="card">
        <h2>Import patients</h2>
        <p>
          Save your spreadsheet as CSV (in Excel: File, Save As, CSV). The first row must name the columns.
          Name and phone are required. Also read: email, date of birth, sex, language, guardian name, guardian phone,
          source (&quot;How did you hear about us?&quot;) and notes.
        </p>
        <p className="muted">
          Nothing is saved by the dry run. Phones already in the system, or repeated in the file, are skipped.
          Imported patients are not opted in to WhatsApp: record each opt-in from the patient.
        </p>
        <ImportForm />
        <p><Link href="/patients">Back to patients</Link></p>
      </div>

      <div className="card">
        <h2>Recent imports and rehearsals</h2>
        {(history?.length ?? 0) === 0 && <p className="muted">None yet.</p>}
        <ul className="list">
          {history?.map((h) => (
            <li key={h.id}>
              {h.dry_run ? 'Dry run' : 'Import'} · {h.file_name ?? 'file'} · {dateIn(h.created_at, member.timezone)}
              <span className="muted"> · {h.total_rows} rows, {h.imported} imported, {h.duplicates} duplicates, {h.errors} errors</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
