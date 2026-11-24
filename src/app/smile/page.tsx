import Link from 'next/link';
import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Smile Passport: a professional smile assessment within 24 hours',
  description: 'Get a professional smile assessment from an orthodontist within 24 hours, online, from anywhere.',
};

type Clinic = {
  name: string;
  fee: number;
  bookingUrl: string | null;
  homeCities: string[];
  orthodontistName: string | null;
  orthodontistBio: string | null;
};

async function loadClinicAndCountVisit(): Promise<Clinic | null> {
  const clinicId = process.env.SMILE_PASSPORT_CLINIC_ID;
  if (!clinicId) return null;
  try {
    const admin = createAdminClient();
    const ua = headers().get('user-agent') ?? '';
    // Page loads only, no personal data. Obvious crawlers are skipped, so this is approximate.
    if (!/bot|crawl|spider|preview|headless/i.test(ua)) await admin.rpc('record_visit', { p_clinic: clinicId });
    const { data } = await admin.from('clinics')
      .select('name, review_fee_inr, booking_url, home_cities, orthodontist_name, orthodontist_bio')
      .eq('id', clinicId).single();
    if (!data) return null;
    return {
      name: data.name,
      fee: data.review_fee_inr ?? 0,
      bookingUrl: data.booking_url,
      homeCities: data.home_cities ?? [],
      orthodontistName: data.orthodontist_name,
      orthodontistBio: data.orthodontist_bio,
    };
  } catch {
    return null;
  }
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Week 2 of the plan: Hero, How it works, Meet the orthodontist, Sample report, FAQs,
// Upload photos, Book consultation. Content links carry ?utm_source=..., which is passed
// on to the scan form so the funnel can show which content brings patients.
export default async function SmileLanding({ searchParams }: { searchParams: { utm_source?: string } }) {
  const clinic = await loadClinicAndCountVisit();
  const fee = clinic?.fee ?? 0;
  const source = (searchParams.utm_source ?? '').trim().slice(0, 60);
  const scanHref = source ? `/smile/scan?utm_source=${encodeURIComponent(source)}` : '/smile/scan';
  const startButton = <Link href={scanHref}><button type="button">Start My Smile Scan</button></Link>;
  const homeCities = clinic?.homeCities.map(titleCase).join(', ');

  return (
    <main className="shell">
      <div className="card">
        <h1>Get a professional smile assessment from an orthodontist within 24 hours, online, from anywhere.</h1>
        <p>
          Upload a few photos of your smile. A licensed orthodontist looks at every case and sends you a
          personal Smile Report: what we see, what may be worth a closer look, your options, and your next steps.
        </p>
        <p>{startButton}</p>
        {fee > 0 && (
          <p className="muted">
            The professional review is ₹{fee}. If you go ahead with treatment, that amount is credited toward your treatment cost.
          </p>
        )}
      </div>

      <div className="card">
        <h2>How it works</h2>
        <ol>
          <li>Upload a front smiling photo and a front teeth photo. A side profile is optional.</li>
          <li>An orthodontist reviews your photos. A person looks at every scan, not just software.</li>
          <li>Within 24 hours you receive your Smile Report by WhatsApp or email.</li>
          <li>
            If you want to go further, book a consultation
            {homeCities ? ` with us in ${homeCities}` : ' with us'}, or we connect you with a trusted
            orthodontist near you.
          </li>
        </ol>
      </div>

      {clinic?.orthodontistName && (
        <div className="card">
          <h2>Meet your orthodontist</h2>
          <p><strong>{clinic.orthodontistName}</strong>{clinic.name ? <span className="muted"> · {clinic.name}</span> : null}</p>
          {clinic.orthodontistBio && <p style={{ whiteSpace: 'pre-wrap' }}>{clinic.orthodontistBio}</p>}
        </div>
      )}

      <div className="card">
        <h2>What your Smile Report looks like</h2>
        <p className="muted">A sample for an imaginary patient. Your report is written for your photos.</p>
        <h3>Smile observations</h3>
        <p>Your upper front teeth are well aligned. The lower front teeth show mild crowding, and the upper midline sits slightly to the left.</p>
        <h3>Areas that may benefit from evaluation</h3>
        <p>Lower front crowding, and how your back teeth meet, which photos cannot show fully.</p>
        <h3>Possible treatment options</h3>
        <p>Clear aligners or fixed braces could both suit a case like this. The right choice depends on an in-person examination.</p>
        <h3>Estimated treatment duration</h3>
        <p>Cases like this often take 9 to 15 months.</p>
        <h3>Next steps</h3>
        <p>Book a consultation for a full examination and X-rays before any treatment decision.</p>
      </div>

      <div className="card">
        <h2>Questions people ask</h2>
        <details>
          <summary>Is this a diagnosis?</summary>
          <p>No. It is a screening review from photos. Any clinical recommendation is made only after an orthodontist examines you in person.</p>
        </details>
        <details>
          <summary>Who looks at my photos?</summary>
          <p>Only our clinical team. Photos are stored privately and are never shared publicly.</p>
        </details>
        <details>
          <summary>What photos do I need?</summary>
          <p>A front photo while smiling and a close front photo of your teeth, biting gently. Good light, no filters. A side profile helps but is optional.</p>
        </details>
        <details>
          <summary>How long does it take?</summary>
          <p>Uploading takes a couple of minutes. Your report arrives within 24 hours. If a photo is unclear we will ask you for a new one.</p>
        </details>
        <details>
          <summary>Do I need braces?</summary>
          <p>That depends on your teeth, bite and goals. The report tells you whether a closer look is worthwhile and what the options are.</p>
        </details>
        <details>
          <summary>I live in another city or country. Can I still use it?</summary>
          <p>Yes. The review is online. If you want treatment, we connect you with a trusted orthodontist near you.</p>
        </details>
        {fee > 0 && (
          <details>
            <summary>What does it cost?</summary>
            <p>The professional review is ₹{fee}. If you start treatment with us, that amount is credited toward your treatment.</p>
          </details>
        )}
      </div>

      <div className="card">
        <h2>Ready?</h2>
        <p>Upload your photos now and hear from an orthodontist within 24 hours.</p>
        <p>{startButton}</p>
        {clinic?.bookingUrl && (
          <p className="muted">
            Already know you want to see us{homeCities ? ` in ${homeCities}` : ''}?{' '}
            <a href={clinic.bookingUrl} target="_blank" rel="noopener noreferrer">Book a consultation</a>
          </p>
        )}
      </div>

      <p className="muted">
        This is a screening review, not a medical diagnosis. A licensed orthodontist reviews your case
        before any clinical recommendation is made.
      </p>
    </main>
  );
}
