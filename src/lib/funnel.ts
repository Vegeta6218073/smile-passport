// Smile Passport funnel helpers: the Day 90 validation targets, finding the weakest step,
// and the spreadsheet export ("a spreadsheet is sufficient initially").

export type FunnelStep = { label: string; value: number };

// "By Day 90, you should have": 100 assessments, 30 reviews, 10 consultations, 3 to 5 treatment starts.
// Keyed by step label so the funnel page can show target against actual.
export const DAY_90_TARGETS: Record<string, { min: number; label: string }> = {
  'Scans completed': { min: 100, label: '100' },
  'Professional reviews delivered': { min: 30, label: '30' },
  'Consultations booked': { min: 10, label: '10' },
  'Treatments started': { min: 3, label: '3 to 5' },
};

// "Where are people dropping off? Improve that stage before adding features."
// Returns the step with the lowest conversion from the step before it, ignoring steps
// whose previous step is empty (no rate to judge).
export function weakestStep(steps: FunnelStep[]): { from: string; to: string; rate: number } | null {
  let worst: { from: string; to: string; rate: number } | null = null;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    if (prev.value <= 0) continue;
    const rate = steps[i].value / prev.value;
    if (!worst || rate < worst.rate) worst = { from: prev.label, to: steps[i].label, rate };
  }
  return worst;
}

// One CSV cell. Quotes when needed, and neutralises cells a spreadsheet would run as a formula
// (names and concerns are typed by the public).
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^\+?\d[\d\s]*$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
