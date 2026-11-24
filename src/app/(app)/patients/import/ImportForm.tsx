'use client';
import { useFormState, useFormStatus } from 'react-dom';
import { runImport, type ImportState } from './actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? 'Working…' : label}</button>;
}

export default function ImportForm() {
  const [state, action] = useFormState<ImportState, FormData>(runImport, null);
  const counts = { ok: 0, duplicate: 0, error: 0 };
  for (const r of state?.results ?? []) counts[r.result] += 1;
  const problemsOnly = (state?.results ?? []).filter((r) => r.result !== 'ok');

  return (
    <>
      <form action={action}>
        <label htmlFor="file">Patient list (CSV)</label>
        <input id="file" name="file" type="file" accept=".csv,text/csv" />
        <Submit label="Check the file (dry run)" />
      </form>

      {state?.problems.map((p) => <p key={p} className="error">{p}</p>)}

      {state && state.results.length > 0 && (
        <>
          <h3>{state.committed ? 'Imported' : 'Dry run'}: {state.fileName}</h3>
          <p>
            <strong>{counts.ok}</strong> {state.committed ? 'imported' : 'ready to import'} ·{' '}
            <strong>{counts.duplicate}</strong> duplicates skipped · <strong>{counts.error}</strong> with errors
          </p>
          {problemsOnly.length > 0 && (
            <ul className="list">
              {problemsOnly.slice(0, 200).map((r) => (
                <li key={r.row_no}>
                  Row {r.row_no}: <span className={r.result === 'error' ? 'error' : 'muted'}>{r.message}</span>
                  {r.patient_id && <> · <a href={`/patients/${r.patient_id}`}>existing patient</a></>}
                </li>
              ))}
            </ul>
          )}
          {!state.committed && counts.ok > 0 && (
            <form action={action}>
              <input type="hidden" name="csv" value={state.csv} />
              <input type="hidden" name="file_name" value={state.fileName} />
              <input type="hidden" name="commit" value="yes" />
              <p className="muted">Fix the rows with errors in your spreadsheet and import them later, or go ahead with the rest now.</p>
              <Submit label={`Import ${counts.ok} patients`} />
            </form>
          )}
        </>
      )}
    </>
  );
}
