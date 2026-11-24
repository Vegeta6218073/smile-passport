export default function NoAccess() {
  return (
    <main className="shell">
      <div className="card">
        <h1>No clinic access</h1>
        <p className="muted">
          Your account is not linked to an active clinic. Ask the clinic owner to add you.
        </p>
      </div>
    </main>
  );
}
