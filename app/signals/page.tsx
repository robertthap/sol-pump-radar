"use client";

import dynamic from "next/dynamic";

const IntelligenceCommitFeed = dynamic(
  () =>
    import("@/components/IntelligenceCommitFeed").then((m) => ({
      default: m.IntelligenceCommitFeed,
    })),
  { ssr: false, loading: () => <div className="card h-40 animate-pulse bg-bg" /> },
);

const SignalDashboard = dynamic(
  () => import("@/components/SignalDashboard").then((m) => ({ default: m.SignalDashboard })),
  { ssr: false, loading: () => <div className="card h-56 animate-pulse bg-bg" /> },
);

export default function SignalsPage() {
  return (
    <main className="app-page space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Signals log</h1>
          <p className="text-sm text-muted">
            Intelligence-commit â†’ decision_log. Live stream when Intelligence / Auto gate filters are on.
          </p>
        </div>
        <a href="/mission" className="text-sm text-brand-600 hover:underline">
          â† Mission control
        </a>
      </div>
      <IntelligenceCommitFeed />
      <SignalDashboard />
    </main>
  );
}
