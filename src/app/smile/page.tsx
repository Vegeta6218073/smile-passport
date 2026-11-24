import Link from 'next/link';
import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Smile Passport: understand your smile',
  description: 'Upload photos and get a personal smile review from a licensed orthodontist.',
};

async function loadClinicAndCountVisit() {
  const clinicId = process.env.SMILE_PASSPORT_CLINIC_ID;
  if (!clinicId) return { fee: 0 };
  try {
    const admin = createAdminClient();
    const ua = headers().get('user-agent') ?? '';
    // Page loads only, no personal data. Obvious crawlers are skipped, so this is approximate.
    if (!/bot|crawl|spider|preview|headless/i.test(ua)) await admin.rpc('record_visit', { p_clinic: clinicId });
    const { data } = await admin.from('clinics').select('review_fee_inr').eq('id', clinicId).single();
    return { fee: data?.review_fee_inr ?? 0 };
  } catch {
    return { fee: 0 };
  }
}

export default async function SmileLanding() {
  const { fee } = await loadClinicAndCountVisit();
  return (
    <main className="shell">
      <div className="card">
        <h1>Understand your smile.</h1>
        <p>
          Upload two photos. A licensed orthodontist reviews them and sends you a personal Smile
          Report within 24 hours, with what we see, what may be worth evaluating, and your next steps.
        </p>
        <p><Link href="/smile/scan"><button type="button">Start My Smile Scan</button></Link></p>
      </div>

      <div className="card">
        <h2>How it works</h2>
        <ol>
          <li>Upload a front smiling photo and a front teeth photo. A side profile is optional.</li>
          <li>An orthodontist reviews your case. A person looks at every scan.</li>
          <li>You receive your Smile Report by WhatsApp or email.</li>
          <li>If you want to go further, book a consultation with us or with a trusted orthodontist near you.</li>
        </ol>
        {fee > 0 && (
          <p>The professional review is ₹{fee}. If you go ahead with treatment, that amount is credited toward your treatment cost.</p>
        )}
      </div>

      <p className="muted">
        This is a screening review, not a medical diagnosis. Any clinical recommendation is made only
        after an orthodontist has assessed your case.
      </p>
    </main>
  );
}
