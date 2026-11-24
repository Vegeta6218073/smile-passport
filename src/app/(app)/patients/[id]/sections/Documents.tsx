import { createClient } from '@/lib/supabase/server';
import { dateIn } from '@/lib/dates';
import { DOCUMENT_KINDS } from '@/lib/clinical';
import { recordPhotoConsent, uploadDocument } from '../clinical-actions';

// Photos, X-rays, consent forms and scans in private storage, shown through 10-minute links (#30, #34).
export default async function Documents({
  patientId, timeZone, patientName,
}: { patientId: string; timeZone: string; patientName: string }) {
  const supabase = createClient();
  const [{ data: docs }, { data: consent }] = await Promise.all([
    supabase.from('documents').select('id, kind, title, storage_path, content_type, source, created_at')
      .eq('patient_id', patientId).order('created_at', { ascending: false }).limit(50),
    supabase.from('consents').select('id').eq('patient_id', patientId).eq('kind', 'photo_use').is('withdrawn_at', null).limit(1),
  ]);
  const paths = docs?.map((d) => d.storage_path) ?? [];
  const { data: signed } = paths.length
    ? await supabase.storage.from('clinic-files').createSignedUrls(paths, 600)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const urlFor = (p: string) => signed?.find((s) => s.path === p)?.signedUrl;
  const label = Object.fromEntries(DOCUMENT_KINDS);
  const hasConsent = (consent?.length ?? 0) > 0;

  return (
    <div className="card">
      <h2>Documents and photos</h2>
      <ul className="list">
        {docs?.map((d) => {
          const url = urlFor(d.storage_path);
          return (
            <li key={d.id}>
              <strong>{label[d.kind] ?? d.kind}</strong> {url ? <a href={url} target="_blank" rel="noopener noreferrer">{d.title ?? 'Open'}</a> : d.title}
              <span className="muted"> · {dateIn(d.created_at, timeZone)}{d.source === 'whatsapp' ? ' · sent on WhatsApp' : ''}</span>
              {url && d.content_type?.startsWith('image/') && (
                <div><img src={url} alt={d.title ?? label[d.kind] ?? 'Document'} style={{ maxWidth: 220, maxHeight: 220 }} /></div>
              )}
            </li>
          );
        })}
        {docs?.length === 0 && <li className="muted">Nothing uploaded yet.</li>}
      </ul>
      <form action={uploadDocument}>
        <input type="hidden" name="patient_id" value={patientId} />
        <label htmlFor="doc-kind">Type</label>
        <select id="doc-kind" name="kind" defaultValue="photo">
          {DOCUMENT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label htmlFor="doc-title">Title</label>
        <input id="doc-title" name="title" placeholder="e.g. OPG before treatment" />
        <label htmlFor="doc-file">File (PDF or image, up to 10 MB)</label>
        <input id="doc-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" capture="environment" required />
        <button type="submit">Upload</button>
      </form>
      <p className="muted">
        Photo consent: <strong>{hasConsent ? 'given' : 'not recorded'}</strong>.
        {hasConsent ? ' Photos sent on WhatsApp are attached here.' : ' Photos sent on WhatsApp are not stored until consent is recorded.'}
      </p>
      {!hasConsent && (
        <form action={recordPhotoConsent}>
          <input type="hidden" name="patient_id" value={patientId} />
          <input name="given_by" defaultValue={patientName} aria-label="Consent given by" required />
          <button type="submit" className="link">Record photo consent</button>
        </form>
      )}
    </div>
  );
}
