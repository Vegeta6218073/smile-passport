import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can, medicalWritable } from '@/lib/roles';
import { dateIn } from '@/lib/dates';
import { LANGUAGES } from '@/lib/constants';
import { advanceStep, saveMedical, setOptIn, startTreatment, updatePatient } from './actions';

export const dynamic = 'force-dynamic';

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

export default async function PatientPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { error?: string; ok?: string };
}) {
  const member = await requireMember();
  const supabase = createClient();

  const { data: patient } = await supabase
    .from('patients').select('*').eq('id', params.id).is('deleted_at', null).maybeSingle();
  if (!patient) notFound();

  const showMedical = can(member.role, 'patient:medical');
  const canTreat = can(member.role, 'treatment:write');

  const [{ data: medical }, { data: treatments }, { data: templates }] = await Promise.all([
    showMedical
      ? supabase.from('patient_medical').select('allergies, medical_history').eq('patient_id', params.id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('patient_treatments')
      .select('id, status, started_at, sop_templates(name, version), treatment_steps(id, position, name, status, due_at, completed_at)')
      .eq('patient_id', params.id)
      .order('started_at', { ascending: false }),
    canTreat
      ? supabase.from('sop_templates').select('id, name, version').eq('status', 'published').order('name')
      : Promise.resolve({ data: [] }),
  ]);

  const tz = member.timezone;
  const isMinor = patient.dob && new Date(patient.dob) > new Date(new Date().setFullYear(new Date().getFullYear() - 18));

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>{patient.full_name}</h2>
        <p className="muted">
          {patient.phone}{patient.email ? ` · ${patient.email}` : ''}
          {patient.dob ? ` · born ${patient.dob}` : ''}{isMinor ? ' · minor' : ''}
        </p>
        {patient.guardian_name && (
          <p className="muted">Guardian: {patient.guardian_name} {patient.guardian_phone ?? ''}</p>
        )}
        <p><Link href={`/appointments?patient=${patient.id}`}>Book an appointment</Link></p>

        <details>
          <summary>Edit details</summary>
          <form action={updatePatient}>
            <input type="hidden" name="patient_id" value={patient.id} />
            <label htmlFor="full_name">Full name</label>
            <input id="full_name" name="full_name" defaultValue={patient.full_name} required />
            <label htmlFor="phone">Mobile number</label>
            <input id="phone" name="phone" inputMode="tel" defaultValue={patient.phone} required />
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" defaultValue={patient.email ?? ''} />
            <label htmlFor="dob">Date of birth</label>
            <input id="dob" name="dob" type="date" defaultValue={patient.dob ?? ''} />
            <label htmlFor="sex">Sex</label>
            <input id="sex" name="sex" defaultValue={patient.sex ?? ''} />
            <label htmlFor="preferred_language">Preferred language</label>
            <select id="preferred_language" name="preferred_language" defaultValue={patient.preferred_language ?? 'en'}>
              {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label htmlFor="guardian_name">Guardian name</label>
            <input id="guardian_name" name="guardian_name" defaultValue={patient.guardian_name ?? ''} />
            <label htmlFor="guardian_phone">Guardian phone</label>
            <input id="guardian_phone" name="guardian_phone" inputMode="tel" defaultValue={patient.guardian_phone ?? ''} />
            <label><input type="checkbox" name="confirm_duplicate" /> Save anyway if another patient has this phone</label>
            <button type="submit">Save changes</button>
          </form>
        </details>

        <form action={setOptIn}>
          <input type="hidden" name="patient_id" value={patient.id} />
          <input type="hidden" name="event" value={patient.whatsapp_opt_in ? 'opt_out' : 'opt_in'} />
          <span>WhatsApp: <strong>{patient.whatsapp_opt_in ? 'opted in' : 'not opted in'}</strong></span>{' '}
          <button type="submit" className="link">
            {patient.whatsapp_opt_in ? 'Record opt-out' : 'Record opt-in'}
          </button>
        </form>
      </div>

      {showMedical && (
        <div className="card">
          <h2>Medical details</h2>
          {medicalWritable(member.role) ? (
            <form action={saveMedical}>
              <input type="hidden" name="patient_id" value={patient.id} />
              <label htmlFor="allergies">Allergies (comma separated)</label>
              <input id="allergies" name="allergies" defaultValue={(medical?.allergies ?? []).join(', ')} />
              <label htmlFor="history">Medical history</label>
              <textarea id="history" name="history" rows={4} defaultValue={medical?.medical_history?.notes ?? ''} />
              <button type="submit">Save</button>
            </form>
          ) : (
            <>
              <p>Allergies: {(medical?.allergies ?? []).join(', ') || 'none recorded'}</p>
              <p>{medical?.medical_history?.notes ?? 'No history recorded.'}</p>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>Treatment journey</h2>
        {treatments?.length === 0 && <p className="muted">No treatment started.</p>}
        {treatments?.map((t) => {
          const tpl = one(t.sop_templates);
          const steps = [...(t.treatment_steps ?? [])].sort((a, b) => a.position - b.position);
          const next = steps.find((s) => s.status === 'pending');
          return (
            <div key={t.id}>
              <h3>{tpl?.name} v{tpl?.version} <span className="muted">({t.status})</span></h3>
              <ul className="list">
                {steps.map((s) => (
                  <li key={s.id}>
                    {s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : '○'} {s.name}{' '}
                    <span className="muted">
                      {s.status === 'done' && s.completed_at ? `done ${dateIn(s.completed_at, tz)}` : ''}
                      {s.status === 'pending' && s.due_at ? `due ${dateIn(s.due_at, tz)}` : ''}
                      {s.status === 'skipped' ? 'skipped' : ''}
                    </span>
                    {canTreat && t.status === 'active' && next?.id === s.id && (
                      <form action={advanceStep} style={{ display: 'inline' }}>
                        <input type="hidden" name="patient_id" value={patient.id} />
                        <input type="hidden" name="step_id" value={s.id} />
                        <button name="status" value="done" type="submit">Complete</button>{' '}
                        <button name="status" value="skipped" type="submit" className="link">Skip</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {canTreat && (templates?.length ?? 0) > 0 && (
          <form action={startTreatment}>
            <input type="hidden" name="patient_id" value={patient.id} />
            <label htmlFor="template_id">Start a treatment</label>
            <select id="template_id" name="template_id">
              {templates?.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}
            </select>
            <button type="submit">Start</button>
          </form>
        )}
        {canTreat && (templates?.length ?? 0) === 0 && (
          <p className="muted">No published SOPs yet. Publish one under SOPs first.</p>
        )}
      </div>
    </>
  );
}
