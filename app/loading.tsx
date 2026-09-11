export default function Loading() {
  return (
    <main aria-busy="true" aria-live="polite" className="loadingShell">
      <p className="loadingWordmark">Nomin</p>
      <p>Loading Trion workspace…</p>
    </main>
  );
}
