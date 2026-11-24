import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { linkFamily } from '../clinical-actions';

const TRIGGER: Record<string, string> = { first_consult: 'after first consultation', mid_treatment: 'mid-treatment', debond: 'after debond' };

// Feedback ratings (#35) and family links (#38) for one patient.
export default async function Relations({
  patientId, timeZone, showFeedback, canLink,
}: { patientId: string; timeZone: string; showFeedback: boolean; canLink: boolean }) {
  const supabase = createClient();
  const [{ data: feedback }, { data: links }, { data: sharing }] = await Promise.all([
    showFeedback ? supabase.from('feedback_requests').select('id, trigger, status, rating, comment, answered_at')
      .eq('patient_id', patientId).order('created_at', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
    supabase.from('patient_family_links').select('patient_id, related_patient_id, relation')
      .or(`patient_id.eq.${patientId},related_patient_id.eq.${patientId}`),
    supabase.from('patients').select('id, full_name, phone').is('deleted_at', null).order('full_name').limit(300),
  ]);
  const name = (id: string) => sharing?.find((p) => p.id === id)?.full_name ?? 'Patient';

  return (
    <div className="card">
      {showFeedback && (
        <>
          <h2>Feedback</h2>
          <ul className="list">
            {feedback?.map((f) => (
              <li key={f.id}>
                {TRIGGER[f.trigger] ?? f.trigger}: {f.rating ? <strong className={f.rating <= 2 ? 'error' : undefined}>{f.rating}/5</strong> : <span className="muted">{f.status.replace('_', ' ')}</span>}
                {f.comment && <span> “{f.comment}”</span>}
                {f.answered_at && <span className="muted"> · {dateIn(f.answered_at, timeZone)}</span>}
              </li>
            ))}
            {feedback?.length === 0 && <li className="muted">No feedback requests yet.</li>}
          </ul>
        </>
      )}
      <h2>Family</h2>
      <ul className="list">
        {links?.map((l) => {
          const other = l.patient_id === patientId ? l.related_patient_id : l.patient_id;
          return <li key={other}><Link href={`/patients/${other}`}>{name(other)}</Link> <span className="muted">({l.relation})</span></li>;
        })}
        {links?.length === 0 && <li className="muted">No family linked.</li>}
      </ul>
      {canLink && (
        <form action={linkFamily}>
          <input type="hidden" name="patient_id" value={patientId} />
          <select name="related_patient_id" defaultValue="" aria-label="Family member" required>
            <option value="" disabled>Link a family member</option>
            {sharing?.filter((p) => p.id !== patientId).map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.phone})</option>)}
          </select>
          <input name="relation" placeholder="e.g. parent, sibling" aria-label="Relation" />
          <button type="submit" className="link">Link</button>
        </form>
      )}
    </div>
  );
}
