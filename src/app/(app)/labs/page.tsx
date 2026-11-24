import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { setLabStatus } from './actions';

export const dynamic = 'force-dynamic';

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

// Roadmap #32. Orders are created from the patient page, where the step they hold up is chosen.
export default async function LabsPage({ searchParams }: { searchParams: { error?: string; ok?: string } }) {
  const member = await requirePermission('lab:write');
  const supabase = createClient();
  const [{ data: open }, { data: recent }] = await Promise.all([
    supabase.from('lab_orders')
      .select('id, patient_id, vendor, item, ordered_at, expected_at, note, patients(full_name), treatment_steps(name)')
      .eq('status', 'ordered').order('expected_at', { ascending: true, nullsFirst: false }),
    supabase.from('lab_orders').select('vendor, ordered_at, expected_at, delivered_at')
      .eq('status', 'delivered').gte('delivered_at', new Date(Date.now() - 180 * 86400_000).toISOString()),
  ]);
  const tz = member.timezone;
  const now = Date.now();
  // Vendor reliability: share of orders delivered by the expected date, last 180 days.
  const vendors = Object.entries((recent ?? []).reduce<Record<string, { n: number; onTime: number; days: number }>>((acc, o) => {
    const v = (acc[o.vendor] ??= { n: 0, onTime: 0, days: 0 });
    v.n += 1;
    if (o.expected_at && o.delivered_at && o.delivered_at <= o.expected_at) v.onTime += 1;
    if (o.delivered_at) v.days += (new Date(o.delivered_at).getTime() - new Date(o.ordered_at).getTime()) / 86400_000;
    return acc;
  }, {})).sort((a, b) => b[1].n - a[1].n);

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}
      <div className="card">
        <h2>Open lab orders</h2>
        <p className="muted">Late orders linked to a treatment step show as the cause of that delayed case.</p>
        {(open?.length ?? 0) === 0 && <p className="muted">Nothing outstanding.</p>}
        <ul className="list">
          {open?.map((o) => {
            const late = o.expected_at && new Date(o.expected_at).getTime() < now;
            return (
              <li key={o.id}>
                <strong>{o.vendor}</strong> · {o.item} for{' '}
                <Link href={`/patients/${o.patient_id}`}>{one(o.patients)?.full_name ?? 'patient'}</Link>
                {one(o.treatment_steps)?.name && <span className="muted"> · holds up “{one(o.treatment_steps)?.name}”</span>}
                <div className={late ? 'error' : 'muted'}>
                  Ordered {dateIn(o.ordered_at, tz)} · expected {o.expected_at ? dateIn(o.expected_at, tz) : 'not set'}{late ? ' · late' : ''}
                  {o.note ? ` · ${o.note}` : ''}
                </div>
                <form action={setLabStatus} style={{ display: 'inline' }}>
                  <input type="hidden" name="id" value={o.id} />
                  <button name="status" value="delivered" type="submit">Delivered</button>{' '}
                  <button name="status" value="cancelled" type="submit" className="link">Cancel</button>
                </form>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="card">
        <h2>Labs, last 180 days</h2>
        {vendors.length === 0 && <p className="muted">No deliveries recorded yet.</p>}
        <ul className="list">
          {vendors.map(([name, v]) => (
            <li key={name}>
              <strong>{name}</strong>{' '}
              <span className="muted">{v.n} delivered · {Math.round((v.onTime / v.n) * 100)}% on time · {Math.round(v.days / v.n)} days on average</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
