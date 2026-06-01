export default function TerminalLoading() {
  return (
    <main className="mx-auto max-w-[1600px] px-3 pb-28 pt-3">
      <div className="space-y-3">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-gray-200" />
        <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
          <div className="h-[70vh] animate-pulse rounded-xl border border-gray-200 bg-white" />
          <div className="flex h-[420px] items-center justify-center rounded-xl border border-gray-200 bg-white text-sm text-gray-500">
            Starting terminal…
          </div>
        </div>
      </div>
    </main>
  );
}
