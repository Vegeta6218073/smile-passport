import { requireRole } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ALL_ROLES, can } from '@/lib/roles';
import { LANGUAGES } from '@/lib/constants';
import { TEMPLATE_KEYS } from '@/lib/settings';
import { AI_FEATURES } from '@/lib/ai/types';
import { rupees } from '@/lib/money';
import {
  addFaq, addPrice, changeStaffRole, inviteStaff, removeKnowledge, saveAiSettings, saveBillingSettings,
  saveClinicSettings, saveScheduleSettings, saveTemplate, setStaffActive,
} from './actions';

const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']] as const;

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  const member = await requireRole(['owner', 'coordinator']);
  const supabase = createClient();
  const manage = can(member.role, 'settings:manage');

  const [{ data: clinic }, { data: templates }, { data: team }, { data: faqs }, { data: prices }] = await Promise.all([
    supabase.from('clinics').select(`name, home_cities, booking_url, review_fee_inr, reply_sla_minutes, orthodontist_name,
      orthodontist_bio, legal_name, gstin, address, invoice_prefix, gst_rate_bps, sac_code, opening_hours, slot_minutes,
      checkin_days_after, lapsed_after_days, google_review_url, ai_enabled, ai_features`)
      .eq('id', member.clinicId).single(),
    supabase.from('message_templates').select('key, language, provider_template_name, body, approved'),
    manage
      ? supabase.from('clinic_members').select('user_id, display_name, role, active').order('created_at')
      : Promise.resolve({ data: [] }),
    supabase.from('clinic_faqs').select('id, question, answer, keywords').order('created_at'),
    supabase.from('clinic_price_ranges').select('id, treatment, min_inr, max_inr, note').order('treatment'),
  ]);
  const hours = (clinic?.opening_hours ?? { days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '19:00' }) as
    { days: number[]; open: string; close: string };
  const aiFeatures = (clinic?.ai_features ?? {}) as Record<string, boolean>;
  const tpl = (key: string, lang: string) => templates?.find((t) => t.key === key && t.language === lang);

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}

      <div className="card">
        <h2>Clinic</h2>
        {manage ? (
          <form action={saveClinicSettings}>
            <label htmlFor="name">Clinic name</label>
            <input id="name" name="name" defaultValue={clinic?.name} required />
            <label htmlFor="home_cities">Home cities (comma separated)</label>
            <input id="home_cities" name="home_cities" defaultValue={(clinic?.home_cities ?? []).join(', ')} />
            <p className="muted">Smile scans from these cities go to your clinic. Everyone else becomes a referral.</p>
            <label htmlFor="booking_url">Booking link (https)</label>
            <input id="booking_url" name="booking_url" type="url" defaultValue={clinic?.booking_url ?? ''} />
            <label htmlFor="review_fee_inr">Smile Passport review fee (₹, 0 for free)</label>
            <input id="review_fee_inr" name="review_fee_inr" type="number" min={0} defaultValue={clinic?.review_fee_inr ?? 0} />
            <label htmlFor="reply_sla_minutes">Enquiry reply target (minutes)</label>
            <input id="reply_sla_minutes" name="reply_sla_minutes" type="number" min={5} defaultValue={clinic?.reply_sla_minutes ?? 120} />
            <label htmlFor="orthodontist_name">Orthodontist shown on the Smile Passport page</label>
            <input id="orthodontist_name" name="orthodontist_name" defaultValue={clinic?.orthodontist_name ?? ''} placeholder="e.g. Dr. Name, MDS (Orthodontics)" />
            <label htmlFor="orthodontist_bio">About the orthodontist</label>
            <textarea id="orthodontist_bio" name="orthodontist_bio" rows={4} maxLength={1000} defaultValue={clinic?.orthodontist_bio ?? ''} />
            <p className="muted">Public. Qualifications and experience help people trust the review. Leave the name empty to hide this section.</p>
            <button type="submit">Save</button>
          </form>
        ) : (
          <p className="muted">Only the owner can change clinic settings.</p>
        )}
      </div>

      {manage && (
        <div className="card">
          <h2>Invoices and receipts</h2>
          <p className="muted">
            Printed on every invoice and receipt, and frozen on each one when it is issued. Whether GST applies to your
            treatments, and at what rate, is for your accountant to confirm. Healthcare services are often exempt (0%).
          </p>
          <form action={saveBillingSettings}>
            <label htmlFor="legal_name">Legal name</label>
            <input id="legal_name" name="legal_name" defaultValue={clinic?.legal_name ?? ''} />
            <label htmlFor="gstin">GSTIN (if registered)</label>
            <input id="gstin" name="gstin" defaultValue={clinic?.gstin ?? ''} maxLength={15} />
            <label htmlFor="address">Address</label>
            <textarea id="address" name="address" rows={2} defaultValue={clinic?.address ?? ''} />
            <label htmlFor="invoice_prefix">Invoice number prefix</label>
            <input id="invoice_prefix" name="invoice_prefix" defaultValue={clinic?.invoice_prefix ?? 'INV'} maxLength={4} />
            <label htmlFor="gst_rate_percent">GST rate (%)</label>
            <input id="gst_rate_percent" name="gst_rate_percent" type="number" min={0} max={28} step="0.01"
              defaultValue={(clinic?.gst_rate_bps ?? 0) / 100} />
            <label htmlFor="sac_code">SAC code</label>
            <input id="sac_code" name="sac_code" defaultValue={clinic?.sac_code ?? ''} />
            <button type="submit">Save</button>
          </form>
        </div>
      )}

      {manage && (
        <div className="card">
          <h2>Hours and follow-up timing</h2>
          <form action={saveScheduleSettings}>
            <fieldset>
              <legend>Open days</legend>
              {WEEKDAYS.map(([n, label]) => (
                <label key={n} style={{ display: 'inline-block', marginRight: 12 }}>
                  <input type="checkbox" name="days" value={n} defaultChecked={hours.days.includes(n)} /> {label}
                </label>
              ))}
            </fieldset>
            <label htmlFor="open">Opens</label>
            <input id="open" name="open" type="time" defaultValue={hours.open} />
            <label htmlFor="close">Closes</label>
            <input id="close" name="close" type="time" defaultValue={hours.close} />
            <label htmlFor="slot_minutes">Consultation length (minutes)</label>
            <input id="slot_minutes" name="slot_minutes" type="number" min={10} max={120} defaultValue={clinic?.slot_minutes ?? 30} />
            <label htmlFor="checkin_days_after">Send a comfort check-in this many days after each visit</label>
            <input id="checkin_days_after" name="checkin_days_after" type="number" min={0} max={30} defaultValue={clinic?.checkin_days_after ?? 2} />
            <label htmlFor="lapsed_after_days">A patient in treatment is lapsed after this many days without a visit</label>
            <input id="lapsed_after_days" name="lapsed_after_days" type="number" min={7} max={365} defaultValue={clinic?.lapsed_after_days ?? 45} />
            <label htmlFor="google_review_url">Google review link (https)</label>
            <input id="google_review_url" name="google_review_url" type="url" defaultValue={clinic?.google_review_url ?? ''} />
            <p className="muted">Happy patients (5 out of 5) are sent this link. Leave empty to skip.</p>
            <button type="submit">Save</button>
          </form>
        </div>
      )}

      {manage && (
        <div className="card">
          <h2>AI assistance</h2>
          <p className="muted">
            AI only drafts, sorts and ranks. Staff approve and send every message, and urgent or unclear replies always
            go to a clinician. The current provider is rule-based and runs inside S-One, so no patient data leaves it.
          </p>
          <form action={saveAiSettings}>
            <label><input type="checkbox" name="ai_enabled" defaultChecked={clinic?.ai_enabled ?? true} /> AI assistance on for this clinic</label>
            {AI_FEATURES.map(([key, label]) => (
              <label key={key}>
                <input type="checkbox" name={`feature_${key}`} defaultChecked={aiFeatures[key] !== false} /> {label}
              </label>
            ))}
            <button type="submit">Save</button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Answers and prices for reply drafts</h2>
        <p className="muted">Drafts only use what is here. If nothing matches a question, the draft says the team will answer.</p>
        <h3>Approved answers</h3>
        <ul className="list">
          {faqs?.map((f) => (
            <li key={f.id}>
              <strong>{f.question}</strong>
              <div>{f.answer}</div>
              {f.keywords?.length > 0 && <div className="muted">Keywords: {f.keywords.join(', ')}</div>}
              {manage && (
                <form action={removeKnowledge}>
                  <input type="hidden" name="id" value={f.id} />
                  <input type="hidden" name="table" value="clinic_faqs" />
                  <button type="submit" className="link">Remove</button>
                </form>
              )}
            </li>
          ))}
          {faqs?.length === 0 && <li className="muted">No answers yet.</li>}
        </ul>
        {manage && (
          <form action={addFaq}>
            <label htmlFor="faq_q">Question</label>
            <input id="faq_q" name="question" placeholder="e.g. Do you offer clear aligners?" required />
            <label htmlFor="faq_a">Approved answer</label>
            <textarea id="faq_a" name="answer" rows={2} required />
            <label htmlFor="faq_k">Keywords (comma separated)</label>
            <input id="faq_k" name="keywords" placeholder="aligners, invisible, clear" />
            <button type="submit">Add answer</button>
          </form>
        )}
        <h3>Price ranges</h3>
        <ul className="list">
          {prices?.map((p) => (
            <li key={p.id}>
              <strong>{p.treatment}</strong> {rupees(p.min_inr * 100)} to {rupees(p.max_inr * 100)}
              {p.note && <span className="muted"> · {p.note}</span>}
              {manage && (
                <form action={removeKnowledge} style={{ display: 'inline' }}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="table" value="clinic_price_ranges" />
                  <button type="submit" className="link">Remove</button>
                </form>
              )}
            </li>
          ))}
          {prices?.length === 0 && <li className="muted">No price ranges yet.</li>}
        </ul>
        {manage && (
          <form action={addPrice}>
            <label htmlFor="pr_t">Treatment</label>
            <input id="pr_t" name="treatment" placeholder="e.g. Braces" required />
            <label htmlFor="pr_min">From (₹)</label>
            <input id="pr_min" name="min_inr" type="number" min={0} required />
            <label htmlFor="pr_max">To (₹)</label>
            <input id="pr_max" name="max_inr" type="number" min={0} required />
            <label htmlFor="pr_note">Note</label>
            <input id="pr_note" name="note" />
            <button type="submit">Save price range</button>
          </form>
        )}
        {!manage && <p className="muted">Only the owner can change answers and prices.</p>}
      </div>

      <div className="card">
        <h2>WhatsApp message templates</h2>
        <p className="muted">
          WhatsApp only allows pre-approved templates. Write the text, submit it to your WhatsApp provider, and tick
          Approved once they approve it. Nothing is sent for a template until it is approved, in the patient&apos;s
          language. In every template {'{{1}}'} is the patient&apos;s first name and {'{{2}}'} the clinic name.
        </p>
        {TEMPLATE_KEYS.map(([key, label, placeholders]) => (
          <details key={key}>
            <summary>
              {label}{' '}
              <span className="muted">
                {LANGUAGES.filter(([lang]) => tpl(key, lang)?.approved).map(([, l]) => l).join(', ') || 'not approved yet'}
              </span>
            </summary>
            <p className="muted">Extra placeholders: {placeholders}.</p>
            {LANGUAGES.map(([lang, langLabel]) => {
              const t = tpl(key, lang);
              return (
                <form action={saveTemplate} key={`${key}-${lang}`}>
                  <h3>{langLabel} {t?.approved ? '✓ approved' : ''}</h3>
                  <input type="hidden" name="key" value={key} />
                  <input type="hidden" name="language" value={lang} />
                  <label htmlFor={`body-${key}-${lang}`}>Message text</label>
                  <textarea id={`body-${key}-${lang}`} name="body" rows={3} defaultValue={t?.body ?? ''} required />
                  <label htmlFor={`pname-${key}-${lang}`}>Template name at your provider</label>
                  <input id={`pname-${key}-${lang}`} name="provider_template_name" defaultValue={t?.provider_template_name ?? ''} />
                  <label><input type="checkbox" name="approved" defaultChecked={t?.approved ?? false} /> Approved by the provider</label>
                  <button type="submit">Save</button>
                </form>
              );
            })}
          </details>
        ))}
      </div>

      {manage && (
        <div className="card">
          <h2>Team</h2>
          <ul className="list">
            {team?.map((m) => (
              <li key={m.user_id}>
                <strong>{m.display_name ?? 'Unnamed'}</strong>{' '}
                <span className="muted">{m.role.replace('_', ' ')}{m.active ? '' : ' · no access'}</span>
                {m.user_id !== member.userId && (
                  <>
                    <form action={changeStaffRole}>
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <select name="role" defaultValue={m.role} aria-label="Role">
                        {ALL_ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                      </select>
                      <button type="submit" className="link">Change role</button>
                    </form>
                    <form action={setStaffActive}>
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <input type="hidden" name="active" value={m.active ? 'false' : 'true'} />
                      <button type="submit" className="link">{m.active ? 'Remove access' : 'Restore access'}</button>
                    </form>
                  </>
                )}
              </li>
            ))}
          </ul>

          <h3>Invite someone</h3>
          <form action={inviteStaff}>
            <label htmlFor="invite-name">Name</label>
            <input id="invite-name" name="display_name" required />
            <label htmlFor="invite-email">Email</label>
            <input id="invite-email" name="email" type="email" required />
            <label htmlFor="invite-role">Role</label>
            <select id="invite-role" name="role" defaultValue="front_desk">
              {ALL_ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
            </select>
            <button type="submit">Send invite</button>
          </form>
        </div>
      )}
    </>
  );
}
