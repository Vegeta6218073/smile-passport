import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { requireMember } from '@/lib/auth';
import { safeSearch } from '@/lib/validation';
import { LANGUAGES, LEAD_SOURCES } from '@/lib/constants';
import { createPatient } from './actions';

export const dynamic = 'force-dynamic';

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: { q?: string; error?: string; ok?: string };
}) {
  await requireMember();
  const supabase = createClient();
  const q = safeSearch(searchParams.q ?? '');

  let query = supabase
    .from('patients')
    .select('id, full_name, phone, whatsapp_opt_in')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);
  const { data: patients, error } = await query;

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>Patients</h2>
        <form method="get">
          <label htmlFor="q">Search by name or phone</label>
          <input id="q" name="q" defaultValue={q} />
          <button type="submit">Search</button>
        </form>
        {error && <p className="error">Could not load patients.</p>}
        <ul className="list">
          {patients?.map((p) => (
            <li key={p.id}>
              <Link href={`/patients/${p.id}`}>{p.full_name}</Link>{' '}
              <span className="muted">{p.phone}{p.whatsapp_opt_in ? ' · WhatsApp on' : ''}</span>
            </li>
          ))}
          {patients?.length === 0 && <li className="muted">No patients found.</li>}
        </ul>
      </div>

      <div className="card">
        <h2>Add patient</h2>
        <form action={createPatient}>
          <label htmlFor="full_name">Full name</label>
          <input id="full_name" name="full_name" required />
          <label htmlFor="phone">Mobile number</label>
          <input id="phone" name="phone" inputMode="tel" required />
          <label htmlFor="dob">Date of birth</label>
          <input id="dob" name="dob" type="date" />
          <label htmlFor="sex">Sex</label>
          <input id="sex" name="sex" />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" />
          <label htmlFor="preferred_language">Preferred language</label>
          <select id="preferred_language" name="preferred_language" defaultValue="en">
            {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label htmlFor="lead_source">How did they hear about us?</label>
          <select id="lead_source" name="lead_source" defaultValue="">
            <option value="">Not recorded</option>
            {LEAD_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label htmlFor="guardian_name">Guardian name (required under 18)</label>
          <input id="guardian_name" name="guardian_name" />
          <label htmlFor="guardian_phone">Guardian phone</label>
          <input id="guardian_phone" name="guardian_phone" inputMode="tel" />
          <label><input type="checkbox" name="consent_data" /> Patient (or guardian) consents to their data being processed</label>
          <label><input type="checkbox" name="whatsapp_opt_in" /> Patient agrees to WhatsApp messages from the clinic</label>
          <label><input type="checkbox" name="confirm_duplicate" /> Add anyway if this phone number already exists</label>
          <button type="submit">Save patient</button>
        </form>
      </div>
    </>
  );
}
