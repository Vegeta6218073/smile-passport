import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { addStep, createSop, newVersion, publishSop, setRetentionLink } from './actions';

export const dynamic = 'force-dynamic';

export default async function SopsPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  const member = await requireMember();
  const canEdit = can(member.role, 'sop:write');
  const { data: templates, error } = await createClient()
    .from('sop_templates')
    .select('id, name, version, status, reviewed_by, phase, retention_sop_name, sop_steps(id, position, name, days_after_previous)')
    .order('name').order('version', { ascending: false });

  const retentionNames = [...new Set((templates ?? []).filter((t) => t.phase === 'retention').map((t) => t.name))];

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}
      {error && <p className="error">Could not load SOPs.</p>}

      {templates?.map((t) => {
        const steps = [...(t.sop_steps ?? [])].sort((a, b) => a.position - b.position);
        return (
          <div className="card" key={t.id}>
            <h2>{t.name} v{t.version} <span className="muted">({t.status}{t.phase === 'retention' ? ', retention phase' : ''})</span></h2>
            {t.reviewed_by && <p className="muted">Signed off by {t.reviewed_by}</p>}
            {t.retention_sop_name && <p className="muted">When complete, starts the retention SOP “{t.retention_sop_name}”.</p>}
            <ol>
              {steps.map((s) => (
                <li key={s.id}>
                  {s.name} <span className="muted">
                    {s.position === 1 ? '' : `${s.days_after_previous} days after the previous step is done`}
                  </span>
                </li>
              ))}
            </ol>
            {canEdit && t.status === 'draft' && (
              <>
                <form action={addStep}>
                  <input type="hidden" name="template_id" value={t.id} />
                  <input name="name" placeholder="Step name" aria-label="Step name" required />
                  <input name="days" type="number" min={0} defaultValue={0} aria-label="Days after previous step" />
                  <button type="submit">Add step</button>
                </form>
                {t.phase === 'treatment' && (
                  <form action={setRetentionLink}>
                    <input type="hidden" name="template_id" value={t.id} />
                    <select name="retention_sop_name" defaultValue={t.retention_sop_name ?? ''} aria-label="Retention SOP after debond">
                      <option value="">No retention phase</option>
                      {retentionNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <button type="submit" className="link">Set retention phase</button>
                  </form>
                )}
                <form action={publishSop}>
                  <input type="hidden" name="template_id" value={t.id} />
                  <input name="reviewed_by" placeholder="Clinician who signed this off" aria-label="Reviewed by" required />
                  <button type="submit">Publish</button>
                </form>
              </>
            )}
            {canEdit && t.status === 'published' && (
              <form action={newVersion}>
                <input type="hidden" name="template_id" value={t.id} />
                <button type="submit" className="link">Create a new version to edit</button>
              </form>
            )}
          </div>
        );
      })}

      {canEdit && (
        <div className="card">
          <h2>New SOP</h2>
          <form action={createSop}>
            <label htmlFor="name">Name</label>
            <input id="name" name="name" placeholder="e.g. Braces treatment" required />
            <label htmlFor="phase">Kind</label>
            <select id="phase" name="phase" defaultValue="treatment">
              <option value="treatment">Treatment</option>
              <option value="retention">Retention (retainer checks, hygiene recalls, 6 and 12 month follow-ups)</option>
            </select>
            <button type="submit">Create draft</button>
          </form>
        </div>
      )}
      {!canEdit && <p className="muted">Only the owner and doctors can edit SOPs.</p>}
    </>
  );
}
