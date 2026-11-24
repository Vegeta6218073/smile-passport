import Link from 'next/link';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { shiftDay, todayIn } from '@/lib/dates';
import { DAY_90_TARGETS, weakestStep } from '@/lib/funnel';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

type SourceRow = { source: string; scans: number; reviews_delivered: number; consults_booked: number; treatments_started: number };

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '–');

// The four numbers from the Smile Passport plan, plus treatments started.
// Cohort view: of the people who scanned in this period, how far did they get.
export default async function FunnelPage({ searchParams }: { searchParams: { days?: string } }) {
  const member = await requirePermission('funnel:view');
  const days = RANGES.find((r) => String(r) === searchParams.days) ?? 30;
  const to = todayIn(member.timezone);
  const from = shiftDay(to, -(days - 1));

  const supabase = createClient();
  const [{ data, error }, { data: sources }] = await Promise.all([
    supabase.rpc('smile_funnel', { p_from: from, p_to: to }),
    supabase.rpc('smile_funnel_sources', { p_from: from, p_to: to }),
  ]);
  const row = data?.[0];
  const n = (v: unknown) => Number(v ?? 0);

  const steps = [
    { label: 'Visitors', value: n(row?.visits) },
    { label: 'Scans completed', value: n(row?.scans) },
    { label: 'Professional reviews delivered', value: n(row?.reviews_delivered) },
    { label: 'Consultations booked', value: n(row?.consults_booked) },
    { label: 'Treatments started', value: n(row?.treatments_started) },
  ];
  const weakest = weakestStep(steps);
  const reviews = n(row?.reviews_delivered);
  const feedback = n(row?.feedback_count);

  return (
    <>
      <div className="card">
        <h2>Smile Passport funnel</h2>
        <p>
          {RANGES.map((r) => (
            <span key={r}>
              {r === days ? <strong>Last {r} days</strong> : <Link href={`/funnel?days=${r}`}>Last {r} days</Link>}{' · '}
            </span>
          ))}
        </p>
        {error && <p className="error">Could not load the funnel.</p>}
        <ul className="list">
          {steps.map((s, i) => {
            const target = days === 90 ? DAY_90_TARGETS[s.label] : undefined;
            return (
              <li key={s.label}>
                <strong>{s.value}</strong> {s.label}
                {i > 0 && <span className="muted"> · {pct(s.value, steps[i - 1].value)} of the step before</span>}
                {target && (
                  <span className={s.value >= target.min ? '' : 'muted'}>
                    {' · '}Day 90 target {target.label} {s.value >= target.min ? '✓' : ''}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {weakest && (
          <p>
            Biggest drop-off: <strong>{weakest.from} → {weakest.to}</strong> ({Math.round(weakest.rate * 100)}%).
            Improve this step before adding features.
          </p>
        )}
        <p className="muted">
          Visitors counts page loads of the landing page and skips obvious crawlers, so treat it as
          approximate. The other numbers count people who scanned in this period.
          {days === 90 && ' Day 90 targets are from the launch plan: reaching them means the idea is validated.'}
        </p>
      </div>

      <div className="card">
        <h2>The 24-hour promise</h2>
        {reviews === 0 ? (
          <p className="muted">No reports sent yet in this period.</p>
        ) : (
          <ul className="list">
            <li><strong>{pct(n(row?.reviews_on_time), reviews)}</strong> of reports reached the person within 24 hours</li>
            <li><strong>{row?.avg_hours_to_report ?? '–'} h</strong> on average from upload to report sent</li>
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Feedback</h2>
        {feedback === 0 ? (
          <p className="muted">No feedback recorded yet. Ask the Week 4 questions when you follow up, and save the answers on the scan.</p>
        ) : (
          <p><strong>{n(row?.would_recommend)}</strong> of {feedback} people asked would recommend Smile Passport.</p>
        )}
      </div>

      <div className="card">
        <h2>Where scans come from</h2>
        <p className="muted">
          From the <code>utm_source</code> on the link people used, for example
          {' '}<code>/smile?utm_source=youtube</code>. Give every piece of content its own source.
        </p>
        {!sources?.length ? (
          <p className="muted">No scans in this period.</p>
        ) : (
          <ul className="list">
            {(sources as SourceRow[]).map((s) => (
              <li key={s.source}>
                <strong>{s.source}</strong>{' '}
                <span className="muted">
                  {n(s.scans)} scans · {n(s.reviews_delivered)} reviews · {n(s.consults_booked)} consultations · {n(s.treatments_started)} treatments
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted"><a href="/scans/export">Download all scans as a spreadsheet (CSV)</a></p>
      </div>
    </>
  );
}
