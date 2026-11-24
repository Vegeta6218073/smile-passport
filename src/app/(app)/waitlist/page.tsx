import Link from 'next/link';
import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn, shiftDay, timeIn, todayIn } from '@/lib/dates';
import { addToWaitlist, bookOffer, removeFromWaitlist } from './actions';

export const dynamic = 'force-dynamic';

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
const OFFER_LABEL: Record<string, string> = { offered: 'offered, waiting for a reply', accepted: 'accepted: book it' };

// Roadmap #40. When a future appointment is cancelled, the slot is offered to the longest-waiting
// matching patient (WhatsApp if opted in, otherwise a call task). One offer at a time, for 24 hours.
export default async function WaitlistPage({ searchParams }: { searchParams: { error?: string; ok?: string } }) {
  const member = await requireMember();
  const supabase = createClient();
  const today = todayIn(member.timezone);
  const [{ data: entries }, { data: offers }, { data: patients }, { data: doctors }] = await Promise.all([
    supabase.from('waitlist_entries').select('id, patient_id, earliest, latest, note, status, patients(full_name)')
      .in('status', ['waiting', 'offered']).order('created_at'),
    supabase.from('slot_offers').select('id, patient_id, starts_at, status, patients(full_name)')
      .in('status', ['offered', 'accepted']).order('starts_at'),
    supabase.from('patients').select('id, full_name').is('deleted_at', null).order('full_name').limit(300),
    supabase.from('clinic_members').select('user_id, display_name').in('role', ['doctor', 'owner']).eq('active', true),
  ]);
  const tz = member.timezone;
  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}
      <div className="card">
        <h2>Slot offers</h2>
        {(offers?.length ?? 0) === 0 && <p className="muted">No open offers.</p>}
        <ul className="list">
          {offers?.map((o) => (
            <li key={o.id}>
              <Link href={`/patients/${o.patient_id}`}>{one(o.patients)?.full_name}</Link>{' '}
              {dateIn(o.starts_at, tz)} {timeIn(o.starts_at, tz)} <span className="muted">· {OFFER_LABEL[o.status] ?? o.status}</span>
              <form action={bookOffer} style={{ display: 'inline' }}>
                <input type="hidden" name="id" value={o.id} />
                <button type="submit">Book</button>
              </form>
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <h2>Waiting for an earlier slot</h2>
        {(entries?.length ?? 0) === 0 && <p className="muted">Nobody waiting.</p>}
        <ul className="list">
          {entries?.map((e) => (
            <li key={e.id}>
              <Link href={`/patients/${e.patient_id}`}>{one(e.patients)?.full_name}</Link>{' '}
              <span className="muted">{e.earliest} to {e.latest}{e.note ? ` · ${e.note}` : ''} · {e.status}</span>
              <form action={removeFromWaitlist} style={{ display: 'inline' }}>
                <input type="hidden" name="id" value={e.id} />
                <button type="submit" className="link">Remove</button>
              </form>
            </li>
          ))}
        </ul>
        <h3>Add someone</h3>
        <form action={addToWaitlist}>
          <label htmlFor="w-patient">Patient</label>
          <select id="w-patient" name="patient_id" defaultValue="" required>
            <option value="" disabled>Choose a patient</option>
            {patients?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
          <label htmlFor="w-earliest">From</label>
          <input id="w-earliest" name="earliest" type="date" defaultValue={today} required />
          <label htmlFor="w-latest">Until</label>
          <input id="w-latest" name="latest" type="date" defaultValue={shiftDay(today, 14)} required />
          <label htmlFor="w-doctor">Doctor</label>
          <select id="w-doctor" name="doctor_id" defaultValue="">
            <option value="">Any</option>
            {doctors?.map((d) => <option key={d.user_id} value={d.user_id}>{d.display_name ?? 'Doctor'}</option>)}
          </select>
          <label htmlFor="w-note">Note</label>
          <input id="w-note" name="note" placeholder="e.g. mornings only" />
          <button type="submit">Add to waitlist</button>
        </form>
      </div>
    </>
  );
}
