/** Instant shell while /trade compiles or navigates (dev compile can take 10–30s). */
export default function TradeLoading() {
  return (
    <main className="mx-auto max-w-[1200px] px-4 pb-12 pt-4">
      <h1 className="mb-3 text-lg font-semibold">Trade</h1>
      <div className="mb-3 h-9 animate-pulse rounded-lg bg-gray-100" />
      <section className="mb-4 card overflow-hidden">
        <div className="space-y-3 px-4 py-5">
          <div className="h-5 w-32 animate-pulse rounded bg-gray-100" />
          <div className="h-4 w-64 animate-pulse rounded bg-gray-100" />
          <div className="h-10 w-40 animate-pulse rounded-lg bg-gray-100" />
        </div>
      </section>
      <div className="card overflow-hidden">
        <div className="h-48 animate-pulse bg-gray-50" />
      </div>
    </main>
  );
}
