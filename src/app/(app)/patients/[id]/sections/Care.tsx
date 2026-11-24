import { createClient } from '@/lib/supabase/server';
import { dateIn, timeIn } from '@/lib/dates';
import { raiseConcern, recordCheckin, sendCheckin } from '../../../concerns/actions';
import { linkVisit, logEmergency, shiftSchedule } from '../billing-actions';

const CHECKIN_LABEL: Record<string, string> = {
  pending: 'to do by phone', sent: 'sent, waiting for a reply', ok: 'OK', concern: 'concern', no_reply: 'no reply', cancelled: 'closed',
};

// Check-ins (#16), concerns (#20) and emergency visits (#23) for one patient.
export default async function Care({
  patientId, timeZone, clinical, clinicalWrite, canBook,
}: { patientId: string; timeZone: string; clinical: boolean; clinicalWrite: boolean; canBook: boolean }) {
  const supabase = createClient();
  const back = `/patients/${patientId}`;
  const [{ data: checkins }, { data: concerns }, { data: emergencies }, { data: active }] = await Promise.all([
    clinical
      ? supabase.from('checkins').select('id, status, reply_text, classification, created_at').eq('patient_id', patientId)
          .order('created_at', { ascending: false }).limit(10)
      : Promise.resolve({ data: [] }),
    clinical
      ? supabase.from('patient_concerns').select('id, severity, summary, status, outcome, created_at').eq('patient_id', patientId)
          .order('created_at', { ascending: false }).limit(10)
      : Promise.resolve({ data: [] }),
    supabase.from('appointments').select('id, starts_at, reason, status').eq('patient_id', patientId)
      .eq('visit_type', 'emergency').order('starts_at', { ascending: false }).limit(5),
    supabase.from('patient_treatments').select('id, treatment_steps(id, name, position, status)')
      .eq('patient_id', patientId).eq('status', 'active').limit(1).maybeSingle(),
  ]);
  const nextStep = [...(active?.treatment_steps ?? [])].sort((a, b) => a.position - b.position).find((s) => s.status === 'pending');
  const linkedIds = new Set<string>();
  if (emergencies?.length) {
    const { data: linked } = await supabase.from('treatment_steps').select('appointment_id').in('appointment_id', emergencies.map((e) => e.id));
    linked?.forEach((l) => l.appointment_id && linkedIds.add(l.appointment_id));
  }

  return (
    <div className="card">
      <h2>Check-ins, concerns and emergencies</h2>

      {clinical && (
        <>
          <h3>Comfort check-ins</h3>
          <ul className="list">
            {checkins?.map((k) => (
              <li key={k.id}>
                {dateIn(k.created_at, timeZone)} · <strong>{CHECKIN_LABEL[k.status] ?? k.status}</strong>
                {k.reply_text && <div>“{k.reply_text}” {k.classification && <span className="muted">(sorted as {k.classification})</span>}</div>}
                {k.status === 'pending' && (
                  <form action={recordCheckin}>
                    <input type="hidden" name="id" value={k.id} />
                    <input type="hidden" name="back" value={back} />
                    <input name="note" placeholder="What did they say?" aria-label="Note" />
                    <button name="status" value="ok" type="submit">All fine</button>{' '}
                    <button name="status" value="concern" type="submit" className="link">Raise a concern</button>
                  </form>
                )}
              </li>
            ))}
            {checkins?.length === 0 && <li className="muted">No check-ins yet. They start automatically after each completed step.</li>}
          </ul>
          <form action={sendCheckin}>
            <input type="hidden" name="patient_id" value={patientId} />
            <button type="submit" className="link">Send a check-in now</button>
          </form>

          <h3>Concerns</h3>
          <ul className="list">
            {concerns?.map((c) => (
              <li key={c.id}>
                <strong className={c.severity === 'urgent' ? 'error' : undefined}>{c.severity}</strong> {c.summary}
                <div className="muted">{dateIn(c.created_at, timeZone)} · {c.status}{c.outcome ? ` · ${c.outcome}` : ''}</div>
              </li>
            ))}
            {concerns?.length === 0 && <li className="muted">None.</li>}
          </ul>
        </>
      )}

      <details>
        <summary>Raise a concern</summary>
        <form action={raiseConcern}>
          <input type="hidden" name="patient_id" value={patientId} />
          <input type="hidden" name="back" value={back} />
          <label htmlFor="c-sev">How serious?</label>
          <select id="c-sev" name="severity" defaultValue="mild">
            <option value="urgent">Urgent: needs a clinician now (bleeding, swelling, severe pain, injury)</option>
            <option value="mild">Mild: discomfort, loose wire or bracket</option>
            <option value="unclear">Not sure</option>
          </select>
          <label htmlFor="c-sum">What did the patient say?</label>
          <textarea id="c-sum" name="summary" rows={2} required />
          <button type="submit">Raise concern</button>
        </form>
      </details>

      <h3>Emergency visits</h3>
      <ul className="list">
        {emergencies?.map((e) => (
          <li key={e.id}>
            {dateIn(e.starts_at, timeZone)} {timeIn(e.starts_at, timeZone)} · {e.reason ?? 'no reason noted'}
            {linkedIds.has(e.id) && <span className="muted"> · counted as a treatment step</span>}
            {clinicalWrite && nextStep && !linkedIds.has(e.id) && ['arrived', 'completed'].includes(e.status) && (
              <form action={linkVisit}>
                <input type="hidden" name="patient_id" value={patientId} />
                <input type="hidden" name="appointment_id" value={e.id} />
                <input type="hidden" name="step_id" value={nextStep.id} />
                <button type="submit" className="link">Count this visit as “{nextStep.name}”</button>
              </form>
            )}
          </li>
        ))}
        {emergencies?.length === 0 && <li className="muted">None.</li>}
      </ul>
      {canBook && (
        <details>
          <summary>Log an emergency visit</summary>
          <p className="muted">Logged now as an attended emergency visit. The treatment schedule does not change unless a clinician links it.</p>
          <form action={logEmergency}>
            <input type="hidden" name="patient_id" value={patientId} />
            <label htmlFor="e-reason">Why did they come in?</label>
            <input id="e-reason" name="reason" placeholder="e.g. Broken bracket, pain" required />
            <button type="submit">Log emergency visit</button>
          </form>
        </details>
      )}
      {clinicalWrite && active && nextStep && (
        <form action={shiftSchedule}>
          <input type="hidden" name="patient_id" value={patientId} />
          <input type="hidden" name="treatment_id" value={active.id} />
          <label htmlFor="shift-days">Move “{nextStep.name}” by days (negative to bring forward)</label>
          <input id="shift-days" name="days" type="number" min={-90} max={90} defaultValue={7} />
          <button type="submit" className="link">Move next step</button>
        </form>
      )}
    </div>
  );
}
