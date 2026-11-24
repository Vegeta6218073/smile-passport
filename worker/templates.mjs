// Pure helpers: no database, no network. Tested in worker/templates.test.mjs.

// Fills the numbered placeholders of an approved WhatsApp template.
// {{1}} patient first name, {{2}} clinic name, {{3}} date, {{4}} time.
export function reminderParams({ patientName, clinicName, startsAt, timeZone }) {
  const first = String(patientName ?? '').trim().split(/\s+/)[0] || 'there';
  const when = new Date(startsAt);
  const date = when.toLocaleDateString('en-IN', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const time = when.toLocaleTimeString('en-IN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true });
  return [first, clinicName, date, time];
}

// Parameters for any template kind. Appointment reminders: {{3}} date, {{4}} time.
// Other kinds: {{1}} first name, {{2}} clinic name, then whatever the queueing function stored.
export function messageParams({ kind, patientName, clinicName, startsAt, timeZone, extra }) {
  if (kind === 'appointment_reminder') return reminderParams({ patientName, clinicName, startsAt, timeZone });
  const first = String(patientName ?? '').trim().split(/\s+/)[0] || 'there';
  return [first, clinicName, ...(Array.isArray(extra) ? extra.map(String) : [])];
}

// For logs and dry runs: shows what the patient would read.
export function renderBody(body, params) {
  return String(body).replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
}

// Keeps the last 4 digits only, so logs never hold a full phone number.
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

// Numbers without a country code are treated as Indian, matching how the app stores them.
export function toE164Digits(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}
