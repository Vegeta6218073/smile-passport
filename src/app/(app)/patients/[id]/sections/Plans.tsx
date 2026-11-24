import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { rupees } from '@/lib/money';
import { DECLINE_REASONS } from '@/lib/clinical';
import { createPlan, draftExplainer, planAction, reviewExplainer } from '../clinical-actions';

// Treatment plans and estimates (#28) with a plain-language explainer a clinician approves (#29).
export default async function Plans({
  patientId, timeZone, canWrite, clinicalWrite, explainerId, aiOn,
}: { patientId: string; timeZone: string; canWrite: boolean; clinicalWrite: boolean; explainerId: string | null; aiOn: boolean }) {
  const supabase = createClient();
  const [{ data: plans }, { data: templates }, { data: explainer }] = await Promise.all([
    supabase.from('treatment_plans')
      .select('id, title, options, cost_paise, duration_months, instalments, status, decline_reason, offered_at, accepted_at, consent_signed_by, template_id')
      .eq('patient_id', patientId).order('created_at', { ascending: false }),
    canWrite ? supabase.from('sop_templates').select('id, name, version').eq('status', 'published').eq('phase', 'treatment').order('name')
      : Promise.resolve({ data: [] }),
    explainerId ? supabase.from('ai_actions').select('id, draft, outcome, subject_id').eq('id', explainerId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const reasonLabel = Object.fromEntries(DECLINE_REASONS);

  return (
    <div className="card" id="plans">
      <h2>Treatment plans and estimates</h2>
      {explainer?.outcome === 'pending' && (
        <div>
          <h3>Plan explainer (draft)</h3>
          {clinicalWrite ? (
            <form action={reviewExplainer}>
              <input type="hidden" name="patient_id" value={patientId} />
              <input type="hidden" name="action_id" value={explainer.id} />
              <textarea name="final_text" rows={6} defaultValue={explainer.draft ?? ''} aria-label="Explainer text" />
              <button type="submit" name="decision" value="approve">Approve</button>{' '}
              <button type="submit" name="decision" value="discard" className="link">Discard</button>
            </form>
          ) : (
            <p className="muted">Waiting for a clinician to approve: {explainer.draft}</p>
          )}
        </div>
      )}
      {(plans?.length ?? 0) === 0 && <p className="muted">No plans yet.</p>}
      <ul className="list">
        {plans?.map((p) => (
          <li key={p.id}>
            <strong>{p.title}</strong> <span className="muted">({p.status})</span>{' '}
            <Link href={`/plan/${p.id}`} target="_blank">Printable estimate</Link>
            <div className="muted">
              {p.cost_paise ? rupees(p.cost_paise) : 'no cost yet'}
              {p.duration_months ? ` · about ${p.duration_months} months` : ''}
              {p.instalments ? ` · ${p.instalments} instalments` : ''}
              {p.offered_at ? ` · offered ${dateIn(p.offered_at, timeZone)}` : ''}
              {p.accepted_at ? ` · accepted ${dateIn(p.accepted_at, timeZone)}, consent signed by ${p.consent_signed_by}` : ''}
              {p.decline_reason ? ` · declined: ${reasonLabel[p.decline_reason] ?? p.decline_reason}` : ''}
            </div>
            {p.options && <div>{p.options}</div>}
            {canWrite && p.status === 'draft' && (
              <form action={planAction} style={{ display: 'inline' }}>
                <input type="hidden" name="patient_id" value={patientId} />
                <input type="hidden" name="plan_id" value={p.id} />
                <button name="op" value="offer" type="submit">Offer to patient</button>
              </form>
            )}
            {canWrite && aiOn && ['draft', 'offered'].includes(p.status) && (
              <form action={draftExplainer} style={{ display: 'inline' }}>
                <input type="hidden" name="patient_id" value={patientId} />
                <input type="hidden" name="plan_id" value={p.id} />
                <button type="submit" className="link">Draft a plain-language explainer</button>
              </form>
            )}
            {canWrite && p.status === 'offered' && (
              <>
                <form action={planAction}>
                  <input type="hidden" name="patient_id" value={patientId} />
                  <input type="hidden" name="plan_id" value={p.id} />
                  <input name="signed_by" placeholder="Consent signed by (patient or guardian)" aria-label="Consent signed by" required />
                  <button name="op" value="accept" type="submit">Accepted and consent signed</button>
                </form>
                <form action={planAction}>
                  <input type="hidden" name="patient_id" value={patientId} />
                  <input type="hidden" name="plan_id" value={p.id} />
                  <select name="reason" defaultValue="" aria-label="Reason" required>
                    <option value="" disabled>Why not?</option>
                    {DECLINE_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <input name="note" placeholder="Note (optional)" aria-label="Note" />
                  <button name="op" value="decline" type="submit" className="link">Declined</button>
                </form>
              </>
            )}
          </li>
        ))}
      </ul>
      {canWrite && (
        <details>
          <summary>New plan</summary>
          <form action={createPlan}>
            <input type="hidden" name="patient_id" value={patientId} />
            <label htmlFor="pl-title">Treatment</label>
            <input id="pl-title" name="title" placeholder="e.g. Fixed braces, both arches" required />
            <label htmlFor="pl-options">What it involves and the options</label>
            <textarea id="pl-options" name="options" rows={3} />
            <label htmlFor="pl-cost">Estimated cost (₹)</label>
            <input id="pl-cost" name="cost" inputMode="decimal" />
            <label htmlFor="pl-months">Duration (months)</label>
            <input id="pl-months" name="duration_months" type="number" min={1} max={120} />
            <label htmlFor="pl-inst">Instalments</label>
            <input id="pl-inst" name="instalments" type="number" min={1} max={36} />
            <label htmlFor="pl-tpl">SOP to start when accepted</label>
            <select id="pl-tpl" name="template_id" defaultValue="">
              <option value="">None (start it by hand)</option>
              {templates?.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}
            </select>
            <button type="submit">Save draft</button>
          </form>
        </details>
      )}
    </div>
  );
}
