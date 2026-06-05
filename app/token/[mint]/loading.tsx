export default function TokenLoading() {
  return (
    <main className="app-page animate-pulse">
      <div className="mb-3 flex justify-between border-b border-border pb-3">
        <div className="h-7 w-48 rounded bg-panel/5" />
        <div className="h-5 w-32 rounded bg-panel/5" />
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <div className="card h-64 lg:col-span-2" />
        <div className="card h-64" />
      </div>
      <div className="card h-48" />
    </main>
  );
}
