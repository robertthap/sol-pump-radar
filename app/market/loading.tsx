export default function MarketLoading() {
  return (
    <main className="px-3 py-4">
      <div className="mb-3 h-7 w-24 animate-pulse rounded bg-panel/5" />
      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-[70vh] animate-pulse rounded-lg border border-border bg-panel/30" />
        ))}
      </div>
    </main>
  );
}
