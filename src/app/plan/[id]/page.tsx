import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { rupees } from '@/lib/money';
import PrintButton from '../../report/[id]/PrintButton';

export const dynamic = 'force-dynamic';

// Printable estimate with a consent signature line (roadmap #28). Wording is a placeholder for counsel.
export default async function PlanPage({ params }: { params: { id: string } }) {
  const member = await requirePermission('treatment:write');
  const supabase = createClient();
  const { data: plan } = await supabase.from('treatment_plans')
    .select('id, title, options, cost_paise, duration_months, instalments, status, created_at, patients(full_name)')
    .eq('id', params.id).maybeSingle();
  if (!plan) notFound();
  const { data: clinic } = await supabase.from('clinics').select('name, legal_name, address').eq('id', member.clinicId).single();
  const patient = Array.isArray(plan.patients) ? plan.patients[0] : plan.patients;

  return (
    <main className="shell" style={{ maxWidth: 720 }}>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>
      <PrintButton />
      <h1>Treatment estimate</h1>
      <p className="muted">{clinic?.legal_name ?? clinic?.name}{clinic?.address ? ` · ${clinic.address}` : ''}</p>
      <p>Prepared for <strong>{patient?.full_name}</strong> on {dateIn(plan.created_at, member.timezone)}</p>
      <h2>{plan.title}</h2>
      {plan.options && <p style={{ whiteSpace: 'pre-wrap' }}>{plan.options}</p>}
      <ul>
        {plan.duration_months && <li>Expected duration: about {plan.duration_months} months</li>}
        {plan.cost_paise && <li>Estimated cost: {rupees(plan.cost_paise)}</li>}
        {plan.instalments && plan.instalments > 1 && <li>Payable in {plan.instalments} instalments</li>}
      </ul>
      <p className="muted">
        This is an estimate. The final plan and cost are confirmed after a full clinical examination.
        {/* TODO(counsel): consent wording */}
      </p>
      <p style={{ marginTop: 48 }}>
        I have read and understood this plan and agree to start treatment.<br /><br />
        Signature: ______________________ Name: ______________________ Date: __________
      </p>
    </main>
  );
}
