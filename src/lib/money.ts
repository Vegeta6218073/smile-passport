// Money is stored in paise (integers). These helpers are the only place that converts.

export function rupees(paise: number | string | bigint | null | undefined): string {
  const n = Number(paise ?? 0) / 100;
  const whole = Number.isInteger(n);
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// "12,500" or "12500.50" -> 1250050. Returns null for anything that is not a positive amount.
export function parseRupees(input: unknown): number | null {
  const s = String(input ?? '').replace(/[₹,\s]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const paise = Math.round(Number(s) * 100);
  return paise > 0 ? paise : null;
}

export const PAYMENT_METHODS = [
  ['upi', 'UPI'],
  ['cash', 'Cash'],
  ['card', 'Card'],
  ['bank_transfer', 'Bank transfer'],
  ['cheque', 'Cheque'],
  ['other', 'Other'],
] as const;
