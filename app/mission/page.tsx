"use client";

import dynamic from "next/dynamic";

const MissionControlShell = dynamic(
  () =>
    import("@/components/mission/MissionControlShell").then((m) => ({
      default: m.MissionControlShell,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-500">
        Loading mission control…
      </div>
    ),
  },
);

export default function MissionPage() {
  return <MissionControlShell />;
}
