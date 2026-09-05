"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const PortalLayout = dynamic(
  () => import("@/components/layout/PortalLayout").then((m) => ({ default: m.PortalLayout })),
  { ssr: false },
);

/** Landing (wallet chooser) uses no shell; /trade and /wallet get the top-bar shell. */
export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/") return <>{children}</>;
  return <PortalLayout>{children}</PortalLayout>;
}
