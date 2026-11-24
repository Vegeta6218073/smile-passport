import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { todayIn } from '@/lib/dates';
import { toCsv } from '@/lib/funnel';
import { LINES, PERIODS, periodRange, type DashboardRow, type Period } from '@/lib/dashboard';

export const dynamic = 'force-dynamic';

// CSV export of the owner dashboard (roadmap #24). Money is in rupees.
export async function GET(request: NextRequest) {
  const member = await requirePermission('dashboard:view');
  const q = request.nextUrl.searchParams.get('period');
  const period: Period = (Object.keys(PERIODS) as Period[]).find((p) => p === q) ?? 'month';
  const r = periodRange(period, todayIn(member.timezone));
  const supabase = createClient();
  const [cur, prev] = await Promise.all([
    supabase.rpc('owner_dashboard', { p_from: r.from, p_to: r.to }),
    supabase.rpc('owner_dashboard', { p_from: r.prevFrom, p_to: r.prevTo }),
  ]);
  if (cur.error || prev.error) return new NextResponse('Could not export.', { status: 500 });
  const c = (cur.data?.[0] ?? {}) as DashboardRow;
  const p = (prev.data?.[0] ?? {}) as DashboardRow;
  const finance = can(member.role, 'finance:view');
  const money = (l: (typeof LINES)[number], v: number) => (l.finance ? v / 100 : v);
  const rows = LINES.filter((l) => finance || !l.finance).map((l) => [
    l.label + (l.finance ? ' (INR)' : '') + (l.format && !l.finance && l.format(1).endsWith('%') ? ' (%)' : ''),
    money(l, l.value(c)), l.snapshot ? '' : money(l, l.value(p)),
  ]);
  const csv = toCsv([`Metric`, `${r.from} to ${r.to}`, `${r.prevFrom} to ${r.prevTo}`], rows);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="dashboard-${period}-${r.to}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
