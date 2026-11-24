import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { todayIn } from '@/lib/dates';
import { FUNNEL_STAGES, LINES, PERIODS, change, periodRange, type DashboardRow, type Period } from '@/lib/dashboard';
import { rupees } from '@/lib/money';

export const dynamic = 'force-dynamic';

const SECTIONS = [['leads', 'Leads and replies'], ['visits', 'Visits'], ['treatment', 'Treatment'], ['money', 'Money']] as const;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');

// Owner dashboard (#24) with week, month and year views against the previous period (#36),
// pilot success criteria (#27), AI draft and sorting rates (#17, #19) and drop-off risk (#26).
// Metric definitions live in src/lib/dashboard.ts. Row-level security decides what each role sees.
export default async function DashboardPage({ searchParams }: { searchParams: { period?: string } }) {
  const member = await requirePermission('dashboard:view');
  const period: Period = (Object.keys(PERIODS) as Period[]).find((p) => p === searchParams.period) ?? 'month';
  const today = todayIn(member.timezone);
  const r = periodRange(period, today);
  const finance = can(member.role, 'finance:view');
  const supabase = createClient();

  const [cur, prev, pilot, ai, agreement, flags, delayed, feedback, plans] = await Promise.all([
    supabase.rpc('owner_dashboard', { p_from: r.from, p_to: r.to }),
    supabase.rpc('owner_dashboard', { p_from: r.prevFrom, p_to: r.prevTo }),
    supabase.rpc('pilot_metrics', { p_from: r.from, p_to: r.to }),
    supabase.from('ai_draft_stats').select('feature, sent_as_is, edited, discarded, pending'),
    supabase.from('classification_agreement').select('ai_label, clinician_label, n'),
    supabase.from('dropoff_flags').select('patient_id, full_name, reasons').limit(50),
    supabase.from('delayed_cases').select('patient_id, full_name, step_name, days_late, cause').order('days_late', { ascending: false }).limit(50),
    supabase.from('feedback_by_doctor').select('doctor_id, doctor_name, answered, average, low_scores'),
    supabase.from('plan_outcomes').select('status, decline_reason, n, value_paise'),
  ]);
  const offered = (plans.data ?? []).filter((x) => x.status === 'offered');
  const declined = (plans.data ?? []).filter((x) => x.status === 'declined');
  const c = (cur.data?.[0] ?? {}) as DashboardRow;
  const p = (prev.data?.[0] ?? {}) as DashboardRow;
  const pm = (pilot.data?.[0] ?? {}) as Record<string, number | null>;
  const num = (v: unknown) => Number(v ?? 0);
  const agreed = (agreement.data ?? []).reduce((s, a) => s + (a.ai_label === a.clinician_label ? num(a.n) : 0), 0);
  const labelled = (agreement.data ?? []).reduce((s, a) => s + num(a.n), 0);

  return (
    <>
      <div className="card">
        <h2>Dashboard</h2>
        <p>
          {(Object.keys(PERIODS) as Period[]).map((k) => (
            <span key={k}>
              {k === period ? <strong>Last {PERIODS[k]} days</strong> : <Link href={`/dashboard?period=${k}`}>Last {PERIODS[k]} days</Link>}{' · '}
            </span>
          ))}
          <a href={`/dashboard/export?period=${period}`}>Download CSV</a>
          {' · '}<Link href="/dashboard/weekly">Weekly summary</Link>
          {' · '}<Link href="/dashboard/sources">Sources</Link>
        </p>
        <p className="muted">{r.from} to {r.to}, compared with {r.prevFrom} to {r.prevTo}. Snapshot numbers are as of now.</p>
        {cur.error && <p className="error">Could not load the dashboard.</p>}
      </div>

      {SECTIONS.map(([key, title]) => {
        const lines = LINES.filter((l) => l.section === key && (finance || !l.finance));
        if (lines.length === 0) return null;
        return (
          <div className="card" key={key} id={key}>
            <h2>{title}</h2>
            <ul className="list">
              {lines.map((l) => {
                const a = l.value(c), b = l.value(p);
                const good = a === b ? null : (a > b) === (l.better === 'up');
                return (
                  <li key={l.key}>
                    <strong>{l.format ? l.format(a) : a}</strong> {l.label}
                    {!l.snapshot && (
                      <span className={good === false ? 'error' : 'muted'}> · {change(a, b)} (was {l.format ? l.format(b) : b})</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {key === 'leads' && (
              <>
                <h3>Enquiry funnel</h3>
                <ul className="list">
                  {FUNNEL_STAGES.map(([k, label], i) => (
                    <li key={k}>
                      <strong>{num(c[k])}</strong> {label}
                      {i > 0 && <span className="muted"> · {pct(num(c[k]), num(c[FUNNEL_STAGES[i - 1][0]]))} of the step before</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        );
      })}

      <div className="card" id="delayed">
        <h2>Delayed cases and why</h2>
        <ul className="list">
          {(delayed.data ?? []).map((d) => (
            <li key={`${d.patient_id}-${d.step_name}`}>
              <Link href={`/patients/${d.patient_id}`}>{d.full_name}</Link> · {d.step_name}{' '}
              <span className="muted">· {d.days_late} days late · {d.cause}</span>
            </li>
          ))}
          {(delayed.data ?? []).length === 0 && <li className="muted">No delayed cases.</li>}
        </ul>
      </div>

      <div className="card" id="plans">
        <h2>Quoted but not started</h2>
        <p>
          <strong>{offered.reduce((a, x) => a + num(x.n), 0)}</strong> plans waiting for a decision
          {finance && <> ({rupees(offered.reduce((a, x) => a + num(x.value_paise), 0))})</>}
          {' · '}<strong>{declined.reduce((a, x) => a + num(x.n), 0)}</strong> declined
        </p>
        <ul className="list">
          {declined.map((x) => <li key={x.decline_reason ?? 'none'}>{(x.decline_reason ?? 'no reason').replace(/_/g, ' ')}: <strong>{num(x.n)}</strong></li>)}
        </ul>
      </div>

      <div className="card" id="feedback">
        <h2>Patient feedback by doctor</h2>
        <ul className="list">
          {(feedback.data ?? []).filter((f) => num(f.answered) > 0).map((f) => (
            <li key={f.doctor_id ?? 'none'}>
              <strong>{f.doctor_name ?? 'No doctor recorded'}</strong>{' '}
              <span className="muted">{f.average}/5 from {num(f.answered)} ratings · {num(f.low_scores)} low (1 or 2)</span>
            </li>
          ))}
          {(feedback.data ?? []).every((f) => num(f.answered) === 0) && <li className="muted">No ratings yet.</li>}
        </ul>
      </div>

      <div className="card" id="pilot">
        <h2>Pilot success criteria</h2>
        <p className="muted">Targets marked TBD are set against the shadow-mode baseline.</p>
        <ul className="list">
          <li><strong>{pm.median_first_reply_minutes ?? '–'} min</strong> median first reply to enquiries <span className="muted">· target under 120 min</span></li>
          <li><strong>{pct(num(pm.on_track), num(pm.active_treatments))}</strong> patients on track ({num(pm.on_track)} of {num(pm.active_treatments)} active treatments with no overdue step)</li>
          {can(member.role, 'usage:view') && (
            <li><strong>{num(pm.owner_open_days)}</strong> of {num(pm.working_days)} working days with the owner in the app</li>
          )}
          <li><strong>{pct(num(pm.patients_with_source), num(pm.patients_registered))}</strong> of new patients have a lead source (enquiries always do)</li>
          <li><strong>{pct(num(pm.no_shows), num(pm.appointments_held))}</strong> no-show rate</li>
          <li><strong>{pct(num(pm.messages_delivered), num(pm.messages_sent))}</strong> of WhatsApp messages delivered ({num(pm.messages_sent)} sent)</li>
          <li><strong>{pm.urgent_median_minutes_to_action ?? '–'} min</strong> median time from an urgent reply to a clinician acknowledging it ({num(pm.urgent_concerns)} urgent)</li>
        </ul>
      </div>

      <div className="card" id="ai">
        <h2>AI drafts and reply sorting</h2>
        <p className="muted">Tracked only. There is no target until a baseline exists.</p>
        <ul className="list">
          {(ai.data ?? []).map((a) => {
            const total = num(a.sent_as_is) + num(a.edited) + num(a.discarded);
            return (
              <li key={a.feature}>
                <strong>{a.feature.replace(/_/g, ' ')}</strong>{' '}
                <span className="muted">
                  {total} reviewed · {pct(num(a.sent_as_is), total)} sent as drafted · {pct(num(a.edited), total)} edited ·
                  {' '}{pct(num(a.discarded), total)} discarded · {num(a.pending)} waiting
                </span>
              </li>
            );
          })}
          {(ai.data ?? []).length === 0 && <li className="muted">No drafts yet.</li>}
          <li>
            <strong>Reply sorting</strong>{' '}
            <span className="muted">
              {labelled ? `${pct(agreed, labelled)} agreement with the clinician on ${labelled} labelled concerns` : 'no clinician labels yet'}
            </span>
          </li>
        </ul>
      </div>

      <div className="card" id="risk">
        <h2>Patients at risk of dropping off</h2>
        <p className="muted">
          Rules: 2 or more missed visits in 90 days, 2 or more unanswered check-ins in 90 days, or 14 or more days behind the SOP.
        </p>
        <ul className="list">
          {(flags.data ?? []).map((f) => (
            <li key={f.patient_id}>
              <Link href={`/patients/${f.patient_id}`}>{f.full_name}</Link>
              <div className="muted">{(f.reasons as string[]).join(' · ')}</div>
            </li>
          ))}
          {(flags.data ?? []).length === 0 && <li className="muted">Nobody flagged.</li>}
        </ul>
      </div>
    </>
  );
}
