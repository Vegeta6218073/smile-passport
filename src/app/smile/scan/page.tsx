import { PHOTO_LABELS, PHOTO_KINDS, REQUIRED_PHOTOS } from '@/lib/scan';

export const metadata = { title: 'Start your Smile Scan' };

export default function ScanForm({ searchParams }: { searchParams: { error?: string; utm_source?: string } }) {
  return (
    <main className="shell">
      <div className="card">
        <h1>Start your Smile Scan</h1>
        {searchParams.error && <p className="error" role="alert">{searchParams.error}</p>}

        <form action="/api/smile/submit" method="post" encType="multipart/form-data">
          <h2>Your photos</h2>
          <p className="muted">
            Good light, no filters. For the teeth photo, smile wide and bite gently. Photos are
            private and only our clinical team can see them. Each must be under 8 MB.
          </p>
          {PHOTO_KINDS.map((kind) => (
            <div key={kind}>
              <label htmlFor={kind}>{PHOTO_LABELS[kind]}</label>
              <input id={kind} name={kind} type="file" accept="image/jpeg,image/png,image/webp"
                required={REQUIRED_PHOTOS.includes(kind)} />
            </div>
          ))}

          <h2>About you</h2>
          <label htmlFor="full_name">Full name</label>
          <input id="full_name" name="full_name" autoComplete="name" required />
          <label htmlFor="phone">Phone (with country code if outside India)</label>
          <input id="phone" name="phone" type="tel" autoComplete="tel" required />
          <label htmlFor="email">Email (optional)</label>
          <input id="email" name="email" type="email" autoComplete="email" />
          <label htmlFor="city">City</label>
          <input id="city" name="city" autoComplete="address-level2" required />
          <label htmlFor="country">Country</label>
          <input id="country" name="country" defaultValue="India" autoComplete="country-name" />
          <label htmlFor="main_concern">What would you like to know? (optional)</label>
          <textarea id="main_concern" name="main_concern" rows={3} maxLength={500} />

          {/* Honeypot: hidden from people, tempting to bots. */}
          <div style={{ position: 'absolute', left: '-9999px' }} aria-hidden="true">
            <label htmlFor="website">Leave this empty</label>
            <input id="website" name="website" tabIndex={-1} autoComplete="off" />
          </div>
          <input type="hidden" name="source" value={searchParams.utm_source ?? ''} />

          {/* TODO(counsel): consent wording is a placeholder until legal review. */}
          <label>
            <input type="checkbox" name="consent_data" required /> I agree that the clinic may store my
            photos and details to review my smile and contact me about it.
          </label>
          <label>
            <input type="checkbox" name="consent_whatsapp" /> It is fine to message me on WhatsApp about my report.
          </label>

          <button type="submit">Send for review</button>
        </form>
        <p className="muted">
          This is a screening review, not a medical diagnosis. A licensed orthodontist reviews every
          case before any recommendation is made.
        </p>
      </div>
    </main>
  );
}
