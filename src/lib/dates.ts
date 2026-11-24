// Clinic-local date helpers. Times are stored as timestamptz; the clinic time zone decides
// what "today" and "10:00" mean.
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now); // YYYY-MM-DD
}

export function timeIn(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export function dateIn(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
}

// Minutes the zone is ahead of UTC at a given instant (e.g. +330 for Asia/Kolkata).
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

// Clinic-local "2026-12-01" + "10:30" -> the real instant.
export function localToUtc(day: string, time: string, timeZone: string): Date {
  const guess = new Date(`${day}T${time}:00Z`);
  const offset = zoneOffsetMinutes(timeZone, guess);
  return new Date(guess.getTime() - offset * 60000);
}

// ISO weekday 1 (Mon) .. 7 (Sun) of a YYYY-MM-DD day.
export function isoWeekday(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
