import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { can } from '@/lib/roles';
import { todayIn } from '@/lib/dates';
import { periodRange, summaryMetrics, type DashboardRow } from '@/lib/dashboard';
import { featureOn, getAiProvider, loadSwitches, logAiAction } from '@/lib/ai/gateway';
import { captureError } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

// Roadmap #41: a plain-language weekly summary. Read-only; every line links to the numbers behind it.
// The provider only sees aggregate counts, never patient data.
export default async function WeeklySummaryPage() {
  const member = await requirePermission('dashboard:view');
  const supabase = createClient();
  const switches = await loadSwitches(supabase, member.clinicId);
  if (!featureOn(switches, 'weekly_summary')) {
    return <div className="card"><h2>Weekly summary</h2><p className="muted">Switched off in Settings.</p></div>;
  }
  const r = periodRange('week', todayIn(member.timezone));
  const [cur, prev, flags, concerns, delayed] = await Promise.all([
    supabase.rpc('owner_dashboard', { p_from: r.from, p_to: r.to }),
    supabase.rpc('owner_dashboard', { p_from: r.prevFrom, p_to: r.prevTo }),
    supabase.from('dropoff_flags').select('patient_id', { count: 'exact', head: true }),
    supabase.from('patient_concerns').select('id', { count: 'exact', head: true }).neq('status', 'resolved'),
    supabase.from('delayed_cases').select('cause'),
  ]);
  const provider = getAiProvider();
  const metrics = summaryMetrics((cur.data?.[0] ?? {}) as DashboardRow, (prev.data?.[0] ?? {}) as DashboardRow, can(member.role, 'finance:view'));
  const lines = await provider.summariseWeek(metrics);
  const lab = (delayed.data ?? []).filter((d) => d.cause.startsWith('Waiting on lab')).length;
  const decisions = [
    (flags.count ?? 0) > 0 && { text: `${flags.count} patients are at risk of dropping off.`, href: '/dashboard#risk' },
    (concerns.count ?? 0) > 0 && { text: `${concerns.count} patient concerns are still open.`, href: '/concerns' },
    (delayed.data?.length ?? 0) > 0 && {
      text: `${delayed.data!.length} cases are behind schedule${lab ? `, ${lab} of them waiting on a lab` : ''}.`, href: '/dashboard#treatment',
    },
  ].filter(Boolean) as { text: string; href: string }[];

  try {
    await logAiAction(createAdminClient(), {
      clinicId: member.clinicId, feature: 'weekly_summary', inputRef: { from: r.from, to: r.to },
      draft: lines.map((l) => l.text).join('\n'), model: provider.name, grounded: true, confidence: 1,
    });
  } catch (err) {
    captureError(err, { page: 'dashboard/weekly' });
  }

  return (
    <div className="card">
      <h2>Weekly summary</h2>
      <p className="muted">{r.from} to {r.to}, compared with the week before. Each line links to its numbers.</p>
      <h3>What changed</h3>
      <ul className="list">
        {lines.map((l) => (
          <li key={l.text}>
            <span className={l.tone === 'bad' ? 'error' : undefined}>{l.text}</span> <Link href={l.href}>See the numbers</Link>
          </li>
        ))}
      </ul>
      <h3>Needs a decision</h3>
      <ul className="list">
        {decisions.map((d) => <li key={d.text}>{d.text} <Link href={d.href}>Open</Link></li>)}
        {decisions.length === 0 && <li className="muted">Nothing waiting on you.</li>}
      </ul>
    </div>
  );
}
