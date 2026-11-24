import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { todayIn } from '@/lib/dates';
import { rupees } from '@/lib/money';
import { LEAD_SOURCES } from '@/lib/constants';
import { PERIODS, periodRange, type Period } from '@/lib/dashboard';
import { saveSpend } from './actions';

export const dynamic = 'force-dynamic';

const label = Object.fromEntries(LEAD_SOURCES) as Record<string, string>;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');

// Roadmap #37: leads and started cases per source, cost per lead and per case where spend is entered,
// and how complete the source field is each month. Patients name the last thing they saw: directional only.
export default async function SourcesPage({ searchParams }: { searchParams: { period?: string; error?: string; ok?: string } }) {
  const member = await requirePermission('dashboard:view');
  const period: Period = (Object.keys(PERIODS) as Period[]).find((p) => p === searchParams.period) ?? 'month';
  const today = todayIn(member.timezone);
  const r = periodRange(period, today);
  const supabase = createClient();
  const [{ data: rows }, { data: completion }] = await Promise.all([
    supabase.rpc('source_report', { p_from: r.from, p_to: r.to }),
    supabase.rpc('source_completion', { p_months: 6 }),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  const sorted = [...(rows ?? [])].sort((a, b) => n(b.leads) - n(a.leads));
  const showMoney = can(member.role, 'finance:view');

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}
      <div className="card">
        <h2>Where patients come from</h2>
        <p>
          {(Object.keys(PERIODS) as Period[]).map((k) => (
            <span key={k}>
              {k === period ? <strong>Last {PERIODS[k]} days</strong> : <Link href={`/dashboard/sources?period=${k}`}>Last {PERIODS[k]} days</Link>}{' · '}
            </span>
          ))}
          <Link href="/dashboard">Back to dashboard</Link>
        </p>
        <p className="muted">
          Leads and cases come from enquiries received in the period; registrations are new patients with that source.
          Patients tend to name the last thing they saw, so treat this as directional. Spend is by calendar month.
        </p>
        <ul className="list">
          {sorted.map((s) => {
            const spend = n(s.spend_paise);
            return (
              <li key={s.source}>
                <strong>{label[s.source] ?? s.source}</strong>{' '}
                <span className="muted">
                  {n(s.leads)} leads · {n(s.consults_booked)} consultations · {n(s.cases_started)} cases started
                  ({pct(n(s.cases_started), n(s.leads))}) · {n(s.registrations)} registrations
                  {showMoney && spend > 0 && <> · spend {rupees(spend)} · {n(s.leads) ? `${rupees(spend / n(s.leads))} per lead` : 'no leads'}
                    {' · '}{n(s.cases_started) ? `${rupees(spend / n(s.cases_started))} per case` : 'no cases yet'}</>}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card">
        <h2>Source field completion</h2>
        <p className="muted">New patients with a lead source recorded. Enquiries always have one.</p>
        <ul className="list">
          {((completion ?? []) as { month: string; registered: number; with_source: number }[]).map((c) => (
            <li key={c.month}>{c.month.slice(0, 7)}: <strong>{pct(n(c.with_source), n(c.registered))}</strong> <span className="muted">({n(c.with_source)} of {n(c.registered)})</span></li>
          ))}
          {(completion ?? []).length === 0 && <li className="muted">No new patients yet.</li>}
        </ul>
      </div>

      {can(member.role, 'finance:write') && (
        <div className="card">
          <h2>Monthly ad spend</h2>
          <form action={saveSpend}>
            <label htmlFor="sp-month">Month</label>
            <input id="sp-month" name="month" type="month" defaultValue={today.slice(0, 7)} required />
            <label htmlFor="sp-source">Source</label>
            <select id="sp-source" name="source" defaultValue="facebook_instagram_ad">
              {LEAD_SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <label htmlFor="sp-amount">Amount (₹)</label>
            <input id="sp-amount" name="amount" inputMode="decimal" required />
            <button type="submit">Save</button>
          </form>
        </div>
      )}
    </>
  );
}
