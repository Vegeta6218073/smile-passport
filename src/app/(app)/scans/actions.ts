'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage, go } from '@/lib/flash';
import { phoneSchema } from '@/lib/validation';

const id = z.string().uuid();

// One helper for the simple "call a database function on a scan" actions.
async function scanAction(
  formData: FormData,
  fn: string,
  extra: (fd: FormData) => Record<string, unknown>,
  okMessage: string,
  permission: 'scan:view' | 'scan:report' = 'scan:view',
) {
  await requirePermission(permission);
  const scanId = id.safeParse(formData.get('scan_id'));
  if (!scanId.success) go('/scans', 'error', 'Invalid request.');
  const path = `/scans/${scanId.data}`;
  const { error } = await createClient().rpc(fn, { p_scan: scanId.data, ...extra(formData) });
  if (error) go(path, 'error', dbMessage(error));
  revalidatePath('/scans');
  revalidatePath(path);
  revalidatePath('/today');
  go(path, 'ok', okMessage);
}

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '');

export const claimScan = async (fd: FormData) =>
  scanAction(fd, 'claim_scan', () => ({}), 'You are reviewing this scan.', 'scan:report');

export const requestBetterPhotos = async (fd: FormData) =>
  scanAction(fd, 'request_better_photos', (f) => ({ p_note: text(f, 'note') }),
    'A task was created to ask for clearer photos.');

export const saveReport = async (fd: FormData) =>
  scanAction(fd, 'save_report', (f) => ({
    p_observations: text(f, 'observations'),
    p_areas: text(f, 'areas'),
    p_options: text(f, 'options'),
    p_duration: text(f, 'duration'),
    p_next_steps: text(f, 'next_steps'),
  }), 'Report saved. Open it to print or share.', 'scan:report');

export const markReportSent = async (fd: FormData) =>
  scanAction(fd, 'mark_report_sent', () => ({}), 'Marked as sent. A follow-up task was created.');

export const markConsultBooked = async (fd: FormData) =>
  scanAction(fd, 'mark_consult_booked', () => ({}), 'Consultation recorded.');

export const markTreatmentStarted = async (fd: FormData) =>
  scanAction(fd, 'mark_treatment_started', () => ({}), 'Treatment recorded.');

export const setPayment = async (fd: FormData) =>
  scanAction(fd, 'set_scan_payment', (f) => ({ p_status: text(f, 'status') }), 'Payment updated.');

export const assignPartner = async (fd: FormData) =>
  scanAction(fd, 'assign_partner', (f) => ({ p_partner: text(f, 'partner_id') || null }), 'Referral partner saved.');

export async function convertToPatient(formData: FormData) {
  await requirePermission('scan:view');
  const scanId = id.safeParse(formData.get('scan_id'));
  if (!scanId.success) go('/scans', 'error', 'Invalid request.');
  const { data, error } = await createClient().rpc('convert_scan_to_patient', { p_scan: scanId.data });
  if (error) go(`/scans/${scanId.data}`, 'error', dbMessage(error));
  revalidatePath('/patients');
  go(`/patients/${data}`, 'ok', 'Linked to a patient record.');
}

export async function addPartner(formData: FormData) {
  const member = await requirePermission('template:write'); // owner and coordinator
  const name = z.string().trim().min(2).max(120).safeParse(formData.get('name'));
  const phone = formData.get('phone') ? phoneSchema.safeParse(formData.get('phone')) : null;
  if (!name.success || (phone && !phone.success)) go('/scans', 'error', 'Check the partner name and phone.');

  const { error } = await createClient().from('referral_partners').insert({
    clinic_id: member.clinicId,
    name: name.data,
    city: String(formData.get('city') ?? '').trim() || null,
    country: String(formData.get('country') ?? '').trim() || null,
    phone: phone?.success ? phone.data : null,
  });
  if (error) go('/scans', 'error', dbMessage(error));
  revalidatePath('/scans');
  go('/scans', 'ok', 'Partner added.');
}
