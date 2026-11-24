import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { STATUS_LABEL } from '@/lib/scan';
import { addPartner } from './actions';

export const dynamic = 'force-dynamic';

const FILTERS = [
  ['open', 'Needs action'],
  ['report_sent', 'Report sent'],
  ['consult_booked', 'Consultation booked'],
  ['all', 'All'],
] as const;

export default async function ScansPage({
  searchParams,
}: {
  searchParams: { f?: string; error?: string; ok?: string };
}) {
  const member = await requirePermission('scan:view');
  const supabase = createClient();
  const filter = FILTERS.some(([k]) => k === searchParams.f) ? searchParams.f! : 'open';

  let query = supabase.from('smile_scans')
    .select('id, full_name, city, route, status, submitted_at, review_due_at')
    .order('review_due_at', { ascending: true }).limit(100);
  if (filter === 'open') query = query.in('status', ['submitted', 'in_review', 'needs_better_photos', 'report_ready']);
  else if (filter !== 'all') query = query.eq('status', filter);

  const [{ data: scans, error }, { data: partners }] = await Promise.all([
    query,
    supabase.from('referral_partners').select('id, name, city, country').eq('active', true).order('name'),
  ]);

  const now = Date.now();
  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>Smile scans</h2>
        <p>
          {FILTERS.map(([k, label]) => (
            <span key={k}>
              {k === filter ? <strong>{label}</strong> : <Link href={`/scans?f=${k}`}>{label}</Link>}{' · '}
            </span>
          ))}
        </p>
        {error && <p className="error">Could not load scans.</p>}
        {scans?.length === 0 && <p className="muted">Nothing here.</p>}
        <ul className="list">
          {scans?.map((s) => {
            const pending = ['submitted', 'in_review'].includes(s.status);
            const hoursLeft = Math.round((new Date(s.review_due_at).getTime() - now) / 3600000);
            return (
              <li key={s.id}>
                <Link href={`/scans/${s.id}`}>{s.full_name}</Link>{' '}
                <span className="muted">
                  {s.city} · {s.route === 'home_clinic' ? 'home clinic' : 'referral'} · {STATUS_LABEL[s.status] ?? s.status}
                </span>
                {pending && (
                  <div className={hoursLeft < 0 ? 'error' : 'muted'}>
                    {hoursLeft < 0 ? `Review overdue by ${-hoursLeft} h` : `Review due in ${hoursLeft} h`}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card">
        <h2>Referral partners</h2>
        <p className="muted">Trusted orthodontists for patients outside your home city.</p>
        <ul className="list">
          {partners?.map((p) => (
            <li key={p.id}>{p.name} <span className="muted">{[p.city, p.country].filter(Boolean).join(', ')}</span></li>
          ))}
          {partners?.length === 0 && <li className="muted">No partners yet.</li>}
        </ul>
        {can(member.role, 'template:write') && (
          <form action={addPartner}>
            <label htmlFor="pname">Partner name</label>
            <input id="pname" name="name" required />
            <label htmlFor="pcity">City</label>
            <input id="pcity" name="city" />
            <label htmlFor="pcountry">Country</label>
            <input id="pcountry" name="country" />
            <label htmlFor="pphone">Phone</label>
            <input id="pphone" name="phone" inputMode="tel" />
            <button type="submit">Add partner</button>
          </form>
        )}
      </div>
    </>
  );
}
