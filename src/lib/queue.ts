// Rule-based Today-queue ranking (roadmap #25). Every score comes with a one-line reason the
// owner can read. No model: revenue at risk, days overdue and patient history, nothing else.

export type QueueRow = {
  kind: string;
  ref_id: string;
  patient_id: string | null;
  title: string;
  due_at: string | null;
  severity?: string | null;
  amount_paise?: number | null;
  patient_no_shows?: number | null;
};

export type RankedRow = QueueRow & { score: number; reason: string };

const HOUR = 3600_000;
const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

export function scoreRow(row: QueueRow, now = Date.now()): { score: number; reason: string } {
  const due = row.due_at ? new Date(row.due_at).getTime() : null;
  const hoursLate = due === null ? 0 : (now - due) / HOUR;
  const daysLate = Math.floor(hoursLate / 24);
  const noShows = row.patient_no_shows ?? 0;

  switch (row.kind) {
    case 'concern':
      if (row.severity === 'urgent') return { score: 1000, reason: 'Urgent patient concern: a clinician must act now' };
      if (row.severity === 'mild') return { score: 600, reason: 'Patient reported a problem' };
      return { score: 500, reason: 'Unclear patient reply: a clinician should read it' };
    case 'enquiry_unreplied':
      return {
        score: 400 + clamp(hoursLate * 10, 200),
        reason: `New lead waiting ${Math.max(1, Math.round(hoursLate))} h past the reply target`,
      };
    case 'scan_review': {
      if (hoursLate >= 0) return { score: 450, reason: 'Smile scan review is past the 24-hour promise' };
      const left = Math.round(-hoursLate);
      return { score: 300 + clamp((24 - left) * 5, 120), reason: `Smile scan review due in ${left} h` };
    }
    case 'payment_overdue': {
      const rupees = Number(row.amount_paise ?? 0) / 100;
      return {
        score: 250 + clamp(rupees / 1000, 150) + clamp(daysLate * 2, 100),
        reason: `₹${rupees.toLocaleString('en-IN')} overdue for ${Math.max(daysLate, 1)} day${daysLate === 1 ? '' : 's'}`,
      };
    }
    case 'overdue_step': {
      const history = noShows > 0 ? `, missed ${noShows} visit${noShows === 1 ? '' : 's'} recently` : '';
      return {
        score: 200 + clamp(daysLate * 5, 200) + clamp(noShows * 30, 90),
        reason: `${Math.max(daysLate, 1)} day${daysLate === 1 ? '' : 's'} behind the treatment schedule${history}`,
      };
    }
    case 'lab_overdue':
      return { score: 220 + clamp(daysLate * 5, 100), reason: `Lab work ${Math.max(daysLate, 1)} days late is holding up treatment` };
    case 'checkin_call':
      return { score: 180, reason: 'Comfort check-in to do by phone (no WhatsApp)' };
    case 'task':
    default:
      return due !== null && hoursLate > 0
        ? { score: 150 + clamp(hoursLate, 100), reason: `Task overdue by ${Math.round(hoursLate)} h` }
        : { score: 120, reason: 'Task due today' };
  }
}

export function rankQueue(rows: QueueRow[], now = Date.now()): RankedRow[] {
  return rows
    .map((r) => ({ ...r, ...scoreRow(r, now) }))
    .sort((a, b) => b.score - a.score
      || (a.due_at ? new Date(a.due_at).getTime() : Infinity) - (b.due_at ? new Date(b.due_at).getTime() : Infinity));
}
