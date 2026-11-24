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

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
