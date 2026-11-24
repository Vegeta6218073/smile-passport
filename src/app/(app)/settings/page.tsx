import { requireRole } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ALL_ROLES, can } from '@/lib/roles';
import { LANGUAGES } from '@/lib/constants';
import { REMINDER_PLACEHOLDERS, TEMPLATE_KEYS } from '@/lib/settings';
import { changeStaffRole, inviteStaff, saveClinicSettings, saveTemplate, setStaffActive } from './actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  const member = await requireRole(['owner', 'coordinator']);
  const supabase = createClient();
  const manage = can(member.role, 'settings:manage');

  const [{ data: clinic }, { data: templates }, { data: team }] = await Promise.all([
    supabase.from('clinics').select('name, home_cities, booking_url, review_fee_inr, reply_sla_minutes')
      .eq('id', member.clinicId).single(),
    supabase.from('message_templates').select('key, language, provider_template_name, body, approved'),
    manage
      ? supabase.from('clinic_members').select('user_id, display_name, role, active').order('created_at')
      : Promise.resolve({ data: [] }),
  ]);
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
            <button type="submit">Save</button>
          </form>
        ) : (
          <p className="muted">Only the owner can change clinic settings.</p>
        )}
      </div>

      <div className="card">
        <h2>WhatsApp message templates</h2>
        <p className="muted">
          WhatsApp only allows pre-approved templates. Write the text, submit it to your WhatsApp provider,
          and tick Approved once they approve it. Reminders are only sent for approved templates.
          Placeholders: {REMINDER_PLACEHOLDERS}.
        </p>
        {TEMPLATE_KEYS.map(([key, label]) =>
          LANGUAGES.map(([lang, langLabel]) => {
            const t = tpl(key, lang);
            return (
              <form action={saveTemplate} key={`${key}-${lang}`}>
                <h3>{label} · {langLabel} {t?.approved ? '✓ approved' : ''}</h3>
                <input type="hidden" name="key" value={key} />
                <input type="hidden" name="language" value={lang} />
                <label htmlFor={`body-${lang}`}>Message text</label>
                <textarea id={`body-${lang}`} name="body" rows={3} defaultValue={t?.body ?? ''} required />
                <label htmlFor={`pname-${lang}`}>Template name at your provider</label>
                <input id={`pname-${lang}`} name="provider_template_name" defaultValue={t?.provider_template_name ?? ''} />
                <label><input type="checkbox" name="approved" defaultChecked={t?.approved ?? false} /> Approved by the provider</label>
                <button type="submit">Save</button>
              </form>
            );
          }),
        )}
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
