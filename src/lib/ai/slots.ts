// Open consultation slots for enquiry drafts ("grounded in live slots").
import { isoWeekday, localToUtc, shiftDay, todayIn } from '../dates';

export type OpeningHours = { days: number[]; open: string; close: string };
export type Busy = { starts_at: string; ends_at: string };

export function openSlots(opts: {
  hours: OpeningHours;
  slotMinutes: number;
  busy: Busy[];
  timeZone: string;
  now?: Date;
  days?: number;
  max?: number;
}): Date[] {
  const { hours, slotMinutes, busy, timeZone, now = new Date(), days = 4, max = 3 } = opts;
  const taken = busy.map((b) => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()] as const);
  const earliest = now.getTime() + 2 * 3600_000;   // never offer a slot less than 2 hours away
  const out: Date[] = [];
  const today = todayIn(timeZone, now);
  for (let d = 0; d <= days && out.length < max; d++) {
    const day = shiftDay(today, d);
    if (!hours.days.includes(isoWeekday(day))) continue;
    const close = localToUtc(day, hours.close, timeZone).getTime();
    for (let t = localToUtc(day, hours.open, timeZone).getTime(); t + slotMinutes * 60000 <= close; t += slotMinutes * 60000) {
      const end = t + slotMinutes * 60000;
      if (t < earliest) continue;
      if (taken.some(([s, e]) => s < end && e > t)) continue;
      out.push(new Date(t));
      break;   // one suggestion per day reads better than three on the same morning
    }
  }
  return out;
}

export function formatSlot(d: Date, timeZone: string): string {
  const day = d.toLocaleDateString('en-IN', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-IN', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day}, ${time}`;
}
