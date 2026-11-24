export const metadata = { title: 'Thank you' };

export default function Thanks() {
  return (
    <main className="shell">
      <div className="card">
        <h1>Thank you. Your photos are in.</h1>
        <p>An orthodontist will review them, and your Smile Report will reach you within 24 hours.</p>
        <p className="muted">
          This is a screening review, not a medical diagnosis. If something looks unclear in your
          photos, we will ask you for new ones.
        </p>
      </div>
    </main>
  );
}
