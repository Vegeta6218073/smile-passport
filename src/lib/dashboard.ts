// Owner dashboard metric definitions (roadmap #24 and #36). One list, used by the page, the CSV
// export and the weekly summary, so every number is defined once.
import { shiftDay } from './dates';
import { rupees } from './money';
import type { Metric } from './ai/types';

export const PERIODS = { week: 7, month: 30, year: 365 } as const;
export type Period = keyof typeof PERIODS;

export function periodRange(period: Period, today: string) {
  const days = PERIODS[period];
  const to = today;
  const from = shiftDay(to, -(days - 1));
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(prevTo, -(days - 1));
  return { from, to, prevFrom, prevTo, days };
}

export type DashboardRow = Record<string, number | string | null>;

const n = (v: unknown) => Number(v ?? 0);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export type Line = {
  key: string;
  section: 'leads' | 'visits' | 'treatment' | 'money';
  label: string;
  value: (r: DashboardRow) => number;
  format?: (v: number) => string;
  better: 'up' | 'down';
  note?: string;
  finance?: boolean;
  snapshot?: boolean;   // a "right now" number, not a period total
};

export const LINES: Line[] = [
  { key: 'leads', section: 'leads', label: 'Leads', value: (r) => n(r.leads), better: 'up' },
  { key: 'conversion', section: 'leads', label: 'Lead-to-case conversion', value: (r) => pct(n(r.cases_started), n(r.leads)), format: (v) => `${v}%`, better: 'up' },
  { key: 'reply_sla', section: 'leads', label: 'Replied within target', value: (r) => pct(n(r.replied_within_sla), n(r.leads)), format: (v) => `${v}%`, better: 'up' },
  { key: 'reply_median', section: 'leads', label: 'Median first reply', value: (r) => n(r.median_reply_minutes), format: (v) => `${v} min`, better: 'down' },
  { key: 'visits', section: 'visits', label: 'Visits', value: (r) => n(r.visits), better: 'up' },
  { key: 'unique_patients', section: 'visits', label: 'Unique patients seen', value: (r) => n(r.unique_patients), better: 'up' },
  { key: 'new_patients', section: 'visits', label: 'New-patient visits', value: (r) => n(r.new_patient_visits), better: 'up' },
  { key: 'walk_ins', section: 'visits', label: 'Walk-ins', value: (r) => n(r.walk_ins), better: 'up' },
  { key: 'no_show_rate', section: 'visits', label: 'No-show rate', value: (r) => pct(n(r.no_shows), n(r.appointments_held)), format: (v) => `${v}%`, better: 'down' },
  { key: 'no_shows_recovered', section: 'visits', label: 'No-shows rebooked', value: (r) => n(r.no_shows_recovered), better: 'up' },
  { key: 'active', section: 'treatment', label: 'Active treatments', value: (r) => n(r.active_treatments), better: 'up', snapshot: true },
  { key: 'delayed', section: 'treatment', label: 'Delayed cases', value: (r) => n(r.delayed_cases), better: 'down', snapshot: true },
  { key: 'billed', section: 'money', label: 'Billed', value: (r) => n(r.billed_paise), format: rupees, better: 'up', finance: true },
  { key: 'collected', section: 'money', label: 'Collected', value: (r) => n(r.collected_paise), format: rupees, better: 'up', finance: true },
  { key: 'overdue', section: 'money', label: 'Overdue instalments', value: (r) => n(r.overdue_paise), format: rupees, better: 'down', finance: true, snapshot: true },
  { key: 'pending', section: 'money', label: 'Still to collect', value: (r) => n(r.pending_paise), format: rupees, better: 'down', finance: true, snapshot: true },
];

export const FUNNEL_STAGES: [string, string][] = [
  ['leads', 'Lead'], ['contacted', 'Contacted'], ['consults_booked', 'Consultation booked'],
  ['consults_attended', 'Consultation attended'], ['plans_offered', 'Plan offered'], ['cases_started', 'Case started'],
];

export function change(cur: number, prev: number): string {
  if (cur === prev) return 'no change';
  if (prev === 0) return 'new';
  const d = Math.round(((cur - prev) / prev) * 100);
  return `${d > 0 ? '+' : ''}${d}%`;
}

// Metrics for the weekly summary: the headline numbers, each linked to where it is shown.
const SUMMARY_KEYS = ['leads', 'conversion', 'reply_sla', 'visits', 'new_patients', 'no_show_rate', 'delayed', 'collected'];
const PERCENT_KEYS = new Set(['conversion', 'reply_sla', 'no_show_rate']);

export function summaryMetrics(cur: DashboardRow, prev: DashboardRow, finance: boolean): Metric[] {
  return LINES.filter((l) => SUMMARY_KEYS.includes(l.key) && (finance || !l.finance)).map((l) => {
    const money = l.key === 'collected';
    return {
      key: l.key,
      label: money ? 'Money collected (₹)' : l.label,
      current: money ? Math.round(l.value(cur) / 100) : l.value(cur),
      previous: money ? Math.round(l.value(prev) / 100) : l.value(prev),
      better: l.better,
      href: `/dashboard?period=week#${l.section}`,
      unit: PERCENT_KEYS.has(l.key) ? '%' : undefined,
    };
  });
}
