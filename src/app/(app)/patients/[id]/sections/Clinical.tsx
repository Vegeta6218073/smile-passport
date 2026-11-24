import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { PERMANENT_TEETH, TOOTH_CONDITIONS, latestByTooth } from '@/lib/clinical';
import { addNote, addToothEntry } from '../clinical-actions';
import { createLabOrder, setLabStatus } from '../../../labs/actions';

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

// Visit notes and tooth chart (#31), and lab orders tied to the step they hold up (#32).
export default async function Clinical({
  patientId, timeZone, canWrite, canLab,
}: { patientId: string; timeZone: string; canWrite: boolean; canLab: boolean }) {
  const supabase = createClient();
  const [{ data: notes }, { data: chart }, { data: labs }, { data: steps }, { data: visits }, { data: staff }] = await Promise.all([
    supabase.from('visit_notes').select('id, body, created_at, author_id, treatment_steps(name)').eq('patient_id', patientId)
      .order('created_at', { ascending: false }).limit(20),
    supabase.from('tooth_chart_entries').select('id, tooth, condition, note, recorded_at').eq('patient_id', patientId)
      .order('recorded_at', { ascending: false }),
    supabase.from('lab_orders').select('id, vendor, item, status, expected_at, delivered_at, treatment_steps(name)')
      .eq('patient_id', patientId).order('ordered_at', { ascending: false }).limit(10),
    supabase.from('treatment_steps').select('id, name, status, position, patient_treatments!inner(patient_id, status)')
      .eq('patient_treatments.patient_id', patientId).eq('patient_treatments.status', 'active').order('position'),
    supabase.from('appointments').select('id, starts_at, visit_type').eq('patient_id', patientId)
      .in('status', ['arrived', 'completed']).order('starts_at', { ascending: false }).limit(10),
    supabase.from('clinic_members').select('user_id, display_name'),
  ]);
  const latest = latestByTooth(chart ?? []);
  const author = (uid: string | null) => staff?.find((s) => s.user_id === uid)?.display_name ?? 'Staff';
  const back = `/patients/${patientId}`;

  return (
    <div className="card">
      <h2>Clinical record</h2>

      <h3>Visit notes</h3>
      <ul className="list">
        {notes?.map((n) => (
          <li key={n.id}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
            <div className="muted">
              {author(n.author_id)} · {dateIn(n.created_at, timeZone)}{one(n.treatment_steps)?.name ? ` · ${one(n.treatment_steps)?.name}` : ''}
            </div>
          </li>
        ))}
        {notes?.length === 0 && <li className="muted">No notes yet.</li>}
      </ul>
      {canWrite && (
        <form action={addNote}>
          <input type="hidden" name="patient_id" value={patientId} />
          <label htmlFor="note-body">New note</label>
          <textarea id="note-body" name="body" rows={3} required />
          <label htmlFor="note-visit">Visit</label>
          <select id="note-visit" name="appointment_id" defaultValue={visits?.[0]?.id ?? ''}>
            <option value="">No visit</option>
            {visits?.map((v) => <option key={v.id} value={v.id}>{dateIn(v.starts_at, timeZone)} ({v.visit_type.replace('_', '-')})</option>)}
          </select>
          <label htmlFor="note-step">Treatment step</label>
          <select id="note-step" name="treatment_step_id" defaultValue="">
            <option value="">None</option>
            {steps?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
          </select>
          <button type="submit">Save note</button>
        </form>
      )}

      <h3>Tooth chart <span className="muted">(FDI)</span></h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(16, 1fr)', gap: 2, fontSize: '0.75rem', textAlign: 'center' }}>
        {PERMANENT_TEETH.map((t) => {
          const e = latest.get(t);
          return (
            <div key={t} title={e ? `${e.condition}${e.note ? `: ${e.note}` : ''}` : 'no entry'}
              style={{ border: '1px solid var(--line)', borderRadius: 4, padding: 2, background: e ? 'var(--bg)' : undefined }}>
              <strong>{t}</strong><br />{e ? e.condition.slice(0, 4) : '·'}
            </div>
          );
        })}
      </div>
      {[...latest.values()].filter((e) => !PERMANENT_TEETH.includes(e.tooth)).map((e) => (
        <p key={e.id} className="muted">Tooth {e.tooth}: {e.condition}</p>
      ))}
      {canWrite && (
        <form action={addToothEntry}>
          <input type="hidden" name="patient_id" value={patientId} />
          <input name="tooth" placeholder="Tooth (e.g. 36)" aria-label="Tooth number" pattern="[1-8][1-8]" required />
          <select name="condition" defaultValue="bracket" aria-label="Condition">
            {TOOTH_CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input name="note" placeholder="Note" aria-label="Note" />
          <button type="submit">Record</button>
        </form>
      )}

      <h3>Lab orders</h3>
      <ul className="list">
        {labs?.map((l) => (
          <li key={l.id}>
            {l.vendor} · {l.item} <span className="muted">
              ({l.status}{l.status === 'ordered' && l.expected_at ? `, expected ${dateIn(l.expected_at, timeZone)}` : ''})
              {one(l.treatment_steps)?.name ? ` · for “${one(l.treatment_steps)?.name}”` : ''}
            </span>
            {canLab && l.status === 'ordered' && (
              <form action={setLabStatus} style={{ display: 'inline' }}>
                <input type="hidden" name="id" value={l.id} />
                <input type="hidden" name="back" value={back} />
                <button name="status" value="delivered" type="submit" className="link">Delivered</button>
              </form>
            )}
          </li>
        ))}
        {labs?.length === 0 && <li className="muted">None.</li>}
      </ul>
      {canLab && (
        <details>
          <summary>New lab order</summary>
          <form action={createLabOrder}>
            <input type="hidden" name="patient_id" value={patientId} />
            <input type="hidden" name="back" value={back} />
            <label htmlFor="lab-vendor">Lab</label>
            <input id="lab-vendor" name="vendor" required />
            <label htmlFor="lab-item">Item</label>
            <input id="lab-item" name="item" placeholder="e.g. Retainers, aligner trays 1-5" required />
            <label htmlFor="lab-exp">Expected by</label>
            <input id="lab-exp" name="expected" type="date" required />
            <label htmlFor="lab-step">Step it holds up</label>
            <select id="lab-step" name="treatment_step_id" defaultValue="">
              <option value="">None</option>
              {steps?.filter((s) => s.status === 'pending').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button type="submit">Save order</button>
          </form>
        </details>
      )}
    </div>
  );
}
