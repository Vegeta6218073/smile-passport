import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { CHANNELS, LANGUAGES, LEAD_SOURCES } from '@/lib/constants';
import { featureOn } from '@/lib/ai/gateway';
import { advanceEnquiry, createEnquiry, draftReply, reviewDraft } from './actions';

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
  searchParams: { error?: string; ok?: string; draft?: string; send?: string };
}) {
  const member = await requireMember();
  const supabase = createClient();
  const draftId = /^[0-9a-f-]{36}$/.test(searchParams.draft ?? '') ? searchParams.draft! : null;
  const [{ data: enquiries, error }, { data: clinic }, { data: draft }] = await Promise.all([
    supabase
      .from('enquiries')
      .select('id, name, phone, lead_source, channel, status, received_at, first_replied_at, lost_reason, message')
      .order('received_at', { ascending: false })
      .limit(50),
    supabase.from('clinics').select('reply_sla_minutes, ai_enabled, ai_features').eq('id', member.clinicId).single(),
    draftId
      ? supabase.from('ai_actions').select('id, draft, outcome, grounded, input_ref, subject_id').eq('id', draftId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const sla = clinic?.reply_sla_minutes ?? 120;
  const drafting = featureOn(clinic, 'enquiry_reply');
  // Only ever link to WhatsApp, whatever arrives in the URL.
  const sendLink = searchParams.send?.startsWith('https://wa.me/') ? searchParams.send : null;
  const draftFor = enquiries?.find((e) => e.id === draft?.subject_id);

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}
      {sendLink && (
        <div className="card">
          <a href={sendLink} target="_blank" rel="noopener noreferrer"><button type="button">Open WhatsApp to send</button></a>
        </div>
      )}

      {draft && draft.outcome === 'pending' && (
        <div className="card" id="draft">
          <h2>Draft reply{draftFor ? ` to ${draftFor.name}` : ''}</h2>
          {draftFor?.message && <p className="muted">They asked: “{draftFor.message}”</p>}
          {draft.grounded === false && (
            <p className="error">No approved answer matched this question. Check and complete the draft before sending.</p>
          )}
          <p className="muted">
            Based on: {((draft.input_ref as { sources?: string[] })?.sources ?? []).join(' · ') || 'nothing specific'}.
            A draft. Nothing is sent until you approve it.
          </p>
          <form action={reviewDraft}>
            <input type="hidden" name="action_id" value={draft.id} />
            <label htmlFor="final_text">Message</label>
            <textarea id="final_text" name="final_text" rows={6} defaultValue={draft.draft ?? ''} maxLength={4000} />
            <button type="submit" name="decision" value="approve">Approve</button>{' '}
            <button type="submit" name="decision" value="discard" className="link">Discard</button>
          </form>
        </div>
      )}

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
          <label htmlFor="message">What did they ask?</label>
          <textarea id="message" name="message" rows={3} maxLength={2000} />
          <label htmlFor="preferred_language">Their language</label>
          <select id="preferred_language" name="preferred_language" defaultValue="en">
            {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
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
                {e.message && <div>“{e.message}”</div>}
                <div className={late ? 'error' : 'muted'}>
                  {e.first_replied_at ? `Replied in ${waited} min` : `Waiting ${waited} min`}
                  {late ? ` (over the ${sla} min target)` : ''}
                  {e.lost_reason ? ` · lost: ${e.lost_reason}` : ''}
                </div>
                {drafting && !e.first_replied_at && e.message && e.status !== 'lost' && (
                  <form action={draftReply} style={{ display: 'inline' }}>
                    <input type="hidden" name="id" value={e.id} />
                    <button type="submit" className="link">Draft a reply</button>{' '}
                  </form>
                )}
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
