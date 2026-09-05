"use client";

import type { ReactNode } from "react";
import { TopNav } from "@/components/layout/TopNav";
import { ModeBanner } from "@/components/runtime/ModeBanner";

/** Top tab-bar shell (dark trading terminal) for /trade and /wallet. Inside the providers, so ModeBanner reads mode state instead of polling. */
export function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <ModeBanner />
      <TopNav />
      <main className="min-h-[calc(100dvh-3.5rem)] w-full min-w-0 px-3 py-4 sm:px-4 lg:px-5 lg:py-5">
        {children}
      </main>
    </div>
  );
}
