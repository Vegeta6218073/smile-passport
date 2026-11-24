import { requireMember } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { can } from '@/lib/roles';
import { addStep, createSop, newVersion, publishSop } from './actions';

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
    .select('id, name, version, status, reviewed_by, sop_steps(id, position, name, days_after_previous)')
    .order('name').order('version', { ascending: false });

  return (
    <>
      {searchParams.error && <p className="error">{searchParams.error}</p>}
      {searchParams.ok && <p>{searchParams.ok}</p>}
      {error && <p className="error">Could not load SOPs.</p>}

      {templates?.map((t) => {
        const steps = [...(t.sop_steps ?? [])].sort((a, b) => a.position - b.position);
        return (
          <div className="card" key={t.id}>
            <h2>{t.name} v{t.version} <span className="muted">({t.status})</span></h2>
            {t.reviewed_by && <p className="muted">Signed off by {t.reviewed_by}</p>}
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
            <button type="submit">Create draft</button>
          </form>
        </div>
      )}
      {!canEdit && <p className="muted">Only the owner and doctors can edit SOPs.</p>}
    </>
  );
}
