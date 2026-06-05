/** Shown immediately while a route segment compiles or loads (dev compile can be slow). */
export default function GlobalLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-brand-500" />
    </div>
  );
}
