import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { CHANNELS, LEAD_SOURCES } from '@/lib/constants';
import { advanceEnquiry, createEnquiry } from './actions';

export const dynamic = 'force-dynamic';

// status -> the next funnel stage staff can stamp
const NEXT_STAGE: Record<string, [string, string]> = {
  new: ['first_reply', 'Mark replied'],
  contacted: ['consult_booked', 'Consult booked'],
  consult_booked: ['consult_attended', 'Consult attended'],
  consult_attended: ['plan_offered', 'Plan offered'],
  plan_offered: ['case_started', 'Case started'],
  case_started: ['case_completed', 'Case completed'],
};

const sourceLabel: Record<string, string> = Object.fromEntries(LEAD_SOURCES);

function minutesBetween(a: string, b: string) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  const member = await requireMember();
  const supabase = createClient();
  const [{ data: enquiries, error }, { data: clinic }] = await Promise.all([
    supabase
      .from('enquiries')
      .select('id, name, phone, lead_source, channel, status, received_at, first_replied_at, lost_reason')
      .order('received_at', { ascending: false })
      .limit(50),
    supabase.from('clinics').select('reply_sla_minutes').eq('id', member.clinicId).single(),
  ]);
  const sla = clinic?.reply_sla_minutes ?? 120;

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>Capture an enquiry</h2>
        <form action={createEnquiry}>
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required />
          <label htmlFor="phone">Mobile number</label>
          <input id="phone" name="phone" inputMode="tel" required />
          <label htmlFor="lead_source">How did they hear about us?</label>
          <select id="lead_source" name="lead_source" defaultValue="" required>
            <option value="" disabled>Choose one</option>
            {LEAD_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label htmlFor="channel">Came in through</label>
          <select id="channel" name="channel" defaultValue="whatsapp">
            {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label htmlFor="referrer_note">Referred by (if any)</label>
          <input id="referrer_note" name="referrer_note" />
          <button type="submit">Save enquiry</button>
        </form>
      </div>

      <div className="card">
        <h2>Enquiries</h2>
        {error && <p className="error">Could not load enquiries.</p>}
        <ul className="list">
          {enquiries?.map((e) => {
            const next = NEXT_STAGE[e.status];
            const waited = e.first_replied_at
              ? minutesBetween(e.received_at, e.first_replied_at)
              : minutesBetween(e.received_at, new Date().toISOString());
            const late = waited > sla;
            return (
              <li key={e.id}>
                <strong>{e.name}</strong>{' '}
                <span className="muted">
                  {e.phone} · {sourceLabel[e.lead_source] ?? e.lead_source} · {e.status.replace(/_/g, ' ')}
                </span>
                <div className={late ? 'error' : 'muted'}>
                  {e.first_replied_at ? `Replied in ${waited} min` : `Waiting ${waited} min`}
                  {late ? ` (over the ${sla} min target)` : ''}
                  {e.lost_reason ? ` · lost: ${e.lost_reason}` : ''}
                </div>
                {next && (
                  <form action={advanceEnquiry} style={{ display: 'inline' }}>
                    <input type="hidden" name="id" value={e.id} />
                    <button name="stage" value={next[0]} type="submit">{next[1]}</button>
                  </form>
                )}
                {e.status !== 'lost' && e.status !== 'case_completed' && (
                  <form action={advanceEnquiry}>
                    <input type="hidden" name="id" value={e.id} />
                    <input type="hidden" name="stage" value="lost" />
                    <input name="reason" placeholder="Reason lost" aria-label="Reason lost" required />
                    <button type="submit" className="link">Mark lost</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
