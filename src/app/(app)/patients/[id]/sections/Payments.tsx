import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { dateIn, todayIn } from '@/lib/dates';
import { PAYMENT_METHODS, rupees } from '@/lib/money';
import { createInstalmentPlan, issueInvoice, recordPayment } from '../billing-actions';

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

// Roadmap #22: instalments, payments, receipts and a GST-ready invoice per treatment.
export default async function Payments({ patientId, canWrite, timeZone }: { patientId: string; canWrite: boolean; timeZone: string }) {
  const supabase = createClient();
  const [{ data: treatments }, { data: docs }] = await Promise.all([
    supabase.from('patient_treatments')
      .select('id, status, total_cost_paise, sop_templates(name), payments(id, instalment_no, amount_paise, due_date, paid_at, paid_amount_paise)')
      .eq('patient_id', patientId).in('status', ['active', 'completed', 'planned'])
      .order('started_at', { ascending: false }),
    supabase.from('invoices').select('id, kind, number, issued_at, amount_paise, patient_treatment_id, status')
      .eq('patient_id', patientId).order('issued_at', { ascending: false }),
  ]);
  const today = todayIn(timeZone);

  return (
    <div className="card">
      <h2>Payments</h2>
      {(treatments?.length ?? 0) === 0 && <p className="muted">No treatment to bill yet.</p>}
      {treatments?.map((t) => {
        const pays = [...(t.payments ?? [])].sort((a, b) => (a.instalment_no ?? 0) - (b.instalment_no ?? 0));
        const paid = pays.reduce((s, p) => s + Number(p.paid_amount_paise ?? 0), 0);
        const invoice = docs?.find((d) => d.kind === 'invoice' && d.patient_treatment_id === t.id && d.status === 'issued');
        return (
          <div key={t.id}>
            <h3>{one(t.sop_templates)?.name ?? 'Treatment'} <span className="muted">({t.status})</span></h3>
            <p className="muted">
              Cost {t.total_cost_paise ? rupees(t.total_cost_paise) : 'not set'} · paid {rupees(paid)}
              {t.total_cost_paise ? ` · balance ${rupees(Number(t.total_cost_paise) - paid)}` : ''}
              {invoice && <> · invoice <Link href={`/receipt/${invoice.id}`} target="_blank">{invoice.number}</Link></>}
            </p>
            <ul className="list">
              {pays.map((p) => {
                const left = Number(p.amount_paise) - Number(p.paid_amount_paise ?? 0);
                const overdue = !p.paid_at && p.due_date < today;
                return (
                  <li key={p.id}>
                    Instalment {p.instalment_no ?? ''}: {rupees(p.amount_paise)} due {dateIn(p.due_date, timeZone)}{' '}
                    <span className={overdue ? 'error' : 'muted'}>
                      {p.paid_at ? '· paid' : left < Number(p.amount_paise) ? `· ${rupees(left)} still due` : overdue ? '· overdue' : ''}
                    </span>
                    {canWrite && !p.paid_at && (
                      <form action={recordPayment}>
                        <input type="hidden" name="patient_id" value={patientId} />
                        <input type="hidden" name="payment_id" value={p.id} />
                        <input name="amount" inputMode="decimal" defaultValue={(left / 100).toString()} aria-label="Amount received (₹)" />
                        <select name="method" defaultValue="upi" aria-label="Method">
                          {PAYMENT_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                        <button type="submit">Record payment</button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
            {canWrite && t.status !== 'completed' && (
              <details>
                <summary>{pays.length ? 'Change the instalment schedule' : 'Set up instalments'}</summary>
                <form action={createInstalmentPlan}>
                  <input type="hidden" name="patient_id" value={patientId} />
                  <input type="hidden" name="treatment_id" value={t.id} />
                  <label htmlFor={`total-${t.id}`}>Treatment cost (₹)</label>
                  <input id={`total-${t.id}`} name="total" inputMode="decimal"
                    defaultValue={t.total_cost_paise ? String(Number(t.total_cost_paise) / 100) : ''} required />
                  <label htmlFor={`count-${t.id}`}>Number of instalments</label>
                  <input id={`count-${t.id}`} name="count" type="number" min={1} max={36} defaultValue={6} />
                  <label htmlFor={`first-${t.id}`}>First due date</label>
                  <input id={`first-${t.id}`} name="first_due" type="date" defaultValue={today} />
                  <label htmlFor={`every-${t.id}`}>Days between instalments</label>
                  <input id={`every-${t.id}`} name="every_days" type="number" min={1} max={180} defaultValue={30} />
                  <p className="muted">Unpaid instalments are replaced. Money already received stays recorded.</p>
                  <button type="submit">Save schedule</button>
                </form>
              </details>
            )}
            {canWrite && !invoice && t.total_cost_paise && (
              <form action={issueInvoice}>
                <input type="hidden" name="patient_id" value={patientId} />
                <input type="hidden" name="treatment_id" value={t.id} />
                <input name="description" placeholder="Invoice description (optional)" aria-label="Invoice description" />
                <button type="submit" className="link">Issue invoice</button>
              </form>
            )}
          </div>
        );
      })}
      {(docs?.filter((d) => d.kind === 'receipt').length ?? 0) > 0 && (
        <>
          <h3>Receipts</h3>
          <ul className="list">
            {docs?.filter((d) => d.kind === 'receipt').map((d) => (
              <li key={d.id}>
                <Link href={`/receipt/${d.id}`} target="_blank">{d.number}</Link>{' '}
                <span className="muted">{rupees(d.amount_paise)} · {dateIn(d.issued_at, timeZone)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
