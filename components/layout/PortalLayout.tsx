"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TopNav } from "@/components/layout/TopNav";

const WorkersStatusBanner = dynamic(
  () => import("@/components/WorkersStatusBanner").then((m) => ({ default: m.WorkersStatusBanner })),
  { ssr: false },
);

/** Top tab-bar shell (dark trading terminal) used for all non-mission, non-home routes. */
export function PortalLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-bg">
      <WorkersStatusBanner deferMs={pathname.startsWith("/trade") ? 60_000 : 0} />
      <TopNav />
      <main className="min-h-[calc(100dvh-3.5rem)] w-full min-w-0 px-3 py-4 sm:px-4 lg:px-5 lg:py-5">
        {children}
      </main>
    </div>
  );
}
