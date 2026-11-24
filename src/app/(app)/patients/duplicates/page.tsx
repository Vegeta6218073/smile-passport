import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { resolveDuplicate } from './actions';

export const dynamic = 'force-dynamic';

// Roadmap #38. Families often share a phone, so a match is a question, not a merge.
export default async function DuplicatesPage({ searchParams }: { searchParams: { error?: string; ok?: string } }) {
  await requirePermission('patient:merge');
  const { data: pairs, error } = await createClient().from('duplicate_candidates')
    .select('patient_a, patient_b, name_a, name_b, phone_a, phone_b, dob_a, dob_b, reason').limit(100);

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}
      <div className="card">
        <h2>Possible duplicates</h2>
        <p className="muted">
          Merging moves every appointment, treatment, payment, message and note onto the record you keep, fills in
          missing details from the other, and archives it. It cannot be undone from the app.
        </p>
        {error && <p className="error">Could not load duplicates.</p>}
        {(pairs?.length ?? 0) === 0 && <p className="muted">No possible duplicates.</p>}
        <ul className="list">
          {pairs?.map((d) => (
            <li key={`${d.patient_a}-${d.patient_b}`}>
              <div>
                <Link href={`/patients/${d.patient_a}`}>{d.name_a}</Link> <span className="muted">{d.phone_a}{d.dob_a ? ` · ${d.dob_a}` : ''}</span>
                {'  and  '}
                <Link href={`/patients/${d.patient_b}`}>{d.name_b}</Link> <span className="muted">{d.phone_b}{d.dob_b ? ` · ${d.dob_b}` : ''}</span>
              </div>
              <div className="muted">{d.reason}</div>
              <form action={resolveDuplicate}>
                <input type="hidden" name="a" value={d.patient_a} />
                <input type="hidden" name="b" value={d.patient_b} />
                <button name="op" value="keep_a" type="submit">Same person: keep {d.name_a}</button>{' '}
                <button name="op" value="keep_b" type="submit" className="link">Same person: keep {d.name_b}</button>{' '}
                <input name="relation" placeholder="relation" aria-label="Relation" style={{ width: 120 }} />
                <button name="op" value="family" type="submit" className="link">Family (shared phone)</button>{' '}
                <button name="op" value="different" type="submit" className="link">Different people</button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
