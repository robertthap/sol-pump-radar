"use client";

import dynamic from "next/dynamic";

const IntelligenceCommitFeed = dynamic(
  () =>
    import("@/components/IntelligenceCommitFeed").then((m) => ({
      default: m.IntelligenceCommitFeed,
    })),
  { ssr: false, loading: () => <div className="card h-40 animate-pulse bg-gray-50" /> },
);

const SignalDashboard = dynamic(
  () => import("@/components/SignalDashboard").then((m) => ({ default: m.SignalDashboard })),
  { ssr: false, loading: () => <div className="card h-56 animate-pulse bg-gray-50" /> },
);

export default function SignalsPage() {
  return (
    <main className="mx-auto max-w-[1200px] space-y-4 px-4 pb-12 pt-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Signals log</h1>
          <p className="text-sm text-muted">
            Intelligence-commit → decision_log. Live stream when Intelligence / Auto gate filters are on.
          </p>
        </div>
        <a href="/mission" className="text-sm text-brand-600 hover:underline">
          ← Mission control
        </a>
      </div>
      <IntelligenceCommitFeed />
      <SignalDashboard />
    </main>
  );
}
