import Link from 'next/link';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { shiftDay, timeIn, todayIn } from '@/lib/dates';
import { VISIT_TYPES } from '@/lib/constants';
import { bookAppointment, changeStatus, reschedule } from './actions';

export const dynamic = 'force-dynamic';

const NEXT: Record<string, [string, string][]> = {
  booked: [['arrived', 'Arrived'], ['no_show', 'No-show'], ['cancelled', 'Cancel']],
  arrived: [['completed', 'Complete'], ['cancelled', 'Cancel']],
};

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: { d?: string; patient?: string; error?: string; ok?: string };
}) {
  const member = await requireMember();
  const supabase = createClient();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.d ?? '') ? searchParams.d! : todayIn(member.timezone);

  const [{ data: appts, error }, { data: patients }, { data: doctors }] = await Promise.all([
    supabase.rpc('appointments_for_day', { p_day: day }),
    supabase.from('patients').select('id, full_name').is('deleted_at', null).order('full_name').limit(300),
    supabase.from('clinic_members').select('user_id, display_name, role').in('role', ['doctor', 'owner']).eq('active', true),
  ]);
  const doctorName = (id: string | null) =>
    doctors?.find((d) => d.user_id === id)?.display_name ?? (id ? 'Doctor' : 'Unassigned');

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>Schedule · {day}</h2>
        <p>
          <Link href={`/appointments?d=${shiftDay(day, -1)}`}>← Previous</Link>{' · '}
          <Link href={`/appointments?d=${todayIn(member.timezone)}`}>Today</Link>{' · '}
          <Link href={`/appointments?d=${shiftDay(day, 1)}`}>Next →</Link>
        </p>
        {error && <p className="error">Could not load the schedule.</p>}
        {appts?.length === 0 && <p className="muted">Nothing booked.</p>}
        <ul className="list">
          {appts?.map((a: any) => (
            <li key={a.id}>
              <strong>{timeIn(a.starts_at, member.timezone)}–{timeIn(a.ends_at, member.timezone)}</strong>{' '}
              <Link href={`/patients/${a.patient_id}`}>{a.patient_name}</Link>{' '}
              <span className="muted">
                {a.visit_type.replace('_', '-')} · {a.chair ?? 'no chair'} · {doctorName(a.doctor_id)} · {a.status.replace('_', '-')}
              </span>
              {NEXT[a.status]?.map(([s, label]) => (
                <form key={s} action={changeStatus} style={{ display: 'inline' }}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="day" value={day} />
                  <button name="status" value={s} type="submit" className="link">{label}</button>{' '}
                </form>
              ))}
              {a.status === 'booked' && (
                <form action={reschedule}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="from" value={day} />
                  <input name="day" type="date" defaultValue={day} aria-label="New date" required />
                  <input name="time" type="time" aria-label="New time" required />
                  <button type="submit" className="link">Reschedule</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Book</h2>
        <form action={bookAppointment}>
          <label htmlFor="patient_id">Patient</label>
          <select id="patient_id" name="patient_id" defaultValue={searchParams.patient ?? ''} required>
            <option value="" disabled>Choose a patient</option>
            {patients?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
          <label htmlFor="day">Date</label>
          <input id="day" name="day" type="date" defaultValue={day} required />
          <label htmlFor="time">Time</label>
          <input id="time" name="time" type="time" required />
          <label htmlFor="minutes">Minutes</label>
          <input id="minutes" name="minutes" type="number" min={5} max={480} defaultValue={30} />
          <label htmlFor="doctor_id">Doctor</label>
          <select id="doctor_id" name="doctor_id" defaultValue="">
            <option value="">Unassigned</option>
            {doctors?.map((d) => <option key={d.user_id} value={d.user_id}>{d.display_name ?? d.role}</option>)}
          </select>
          <label htmlFor="chair">Chair</label>
          <input id="chair" name="chair" placeholder="e.g. Chair 1" />
          <label htmlFor="visit_type">Visit type</label>
          <select id="visit_type" name="visit_type" defaultValue="follow_up">
            {VISIT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="submit">Book</button>
        </form>
      </div>
    </>
  );
}
