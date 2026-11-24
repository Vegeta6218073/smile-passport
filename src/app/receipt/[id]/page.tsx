import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { rupees } from '@/lib/money';
import PrintButton from '../../report/[id]/PrintButton';

export const dynamic = 'force-dynamic';

const METHOD: Record<string, string> = {
  upi: 'UPI', cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other',
};

// Printable receipt or invoice (roadmap #22). Seller details are the snapshot taken when it was issued.
// GST-ready layout; the exact format and whether GST applies are for the clinic's accountant to confirm.
export default async function ReceiptPage({ params }: { params: { id: string } }) {
  const member = await requirePermission('finance:view');
  const { data: doc } = await createClient().from('invoices')
    .select('id, kind, number, issued_at, amount_paise, tax_paise, taxable_paise, method, seller, buyer_name, description, status')
    .eq('id', params.id).maybeSingle();
  if (!doc) notFound();
  const seller = (doc.seller ?? {}) as { name?: string; gstin?: string; address?: string; sac?: string; gst_rate_bps?: number };
  const rate = (seller.gst_rate_bps ?? 0) / 100;
  const isInvoice = doc.kind === 'invoice';

  return (
    <main className="shell" style={{ maxWidth: 720 }}>
      <style>{`@media print { .no-print { display: none !important; } }`}</style>
      <PrintButton />
      <h1>{isInvoice ? (seller.gstin && rate > 0 ? 'Tax invoice' : 'Invoice') : 'Payment receipt'}</h1>
      {doc.status === 'cancelled' && <p className="error">Cancelled</p>}
      <p>
        <strong>{seller.name ?? member.clinicName}</strong><br />
        {seller.address && <>{seller.address}<br /></>}
        {seller.gstin && <>GSTIN: {seller.gstin}<br /></>}
      </p>
      <p>
        No. <strong>{doc.number}</strong> · {dateIn(doc.issued_at, member.timezone)}<br />
        {isInvoice ? 'Billed to' : 'Received from'}: <strong>{doc.buyer_name}</strong>
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td>{doc.description ?? 'Treatment'}{seller.sac ? ` (SAC ${seller.sac})` : ''}</td><td style={{ textAlign: 'right' }}>{rupees(doc.taxable_paise ?? doc.amount_paise)}</td></tr>
          {Number(doc.tax_paise) > 0 && (
            <tr><td>GST at {rate}% (included)</td><td style={{ textAlign: 'right' }}>{rupees(doc.tax_paise)}</td></tr>
          )}
          <tr><td><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>{rupees(doc.amount_paise)}</strong></td></tr>
        </tbody>
      </table>
      {!isInvoice && doc.method && <p>Paid by {METHOD[doc.method] ?? doc.method}.</p>}
      <p className="muted">This is a computer-generated document.</p>
    </main>
  );
}
