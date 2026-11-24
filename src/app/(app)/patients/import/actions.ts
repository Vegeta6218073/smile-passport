'use server';
import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { dbMessage } from '@/lib/flash';
import { toImportRows } from '@/lib/importer';

const MAX_BYTES = 2 * 1024 * 1024;

export type ImportResult = { row_no: number; result: 'ok' | 'duplicate' | 'error'; message: string | null; patient_id: string | null };
export type ImportState = { committed: boolean; fileName: string; results: ImportResult[]; problems: string[]; csv: string } | null;

// Step 1 (dry run) and step 2 (commit) use the same file, carried in a hidden field so
// the committed rows are exactly the rows that were checked.
export async function runImport(_prev: ImportState, formData: FormData): Promise<ImportState> {
  await requirePermission('patient:import');
  const commit = formData.get('commit') === 'yes';
  let csv = String(formData.get('csv') ?? '');
  let fileName = String(formData.get('file_name') ?? '');
  const file = formData.get('file');
  if (!commit && file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) return { committed: false, fileName: file.name, results: [], problems: ['The file is larger than 2 MB. Split it.'], csv: '' };
    csv = await file.text();
    fileName = file.name;
  }
  if (!csv.trim()) return { committed: false, fileName, results: [], problems: ['Choose a CSV file first.'], csv: '' };

  const { rows, problems } = toImportRows(csv);
  if (rows.length === 0) return { committed: false, fileName, results: [], problems, csv };

  const { data, error } = await createClient().rpc('import_patients', {
    p_rows: rows, p_commit: commit, p_allow_duplicates: false, p_file_name: fileName || null,
  });
  if (error) return { committed: false, fileName, results: [], problems: [...problems, dbMessage(error)], csv };
  if (commit) revalidatePath('/patients');
  return { committed: commit, fileName, results: (data ?? []) as ImportResult[], problems, csv: commit ? '' : csv };
}
