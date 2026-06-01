"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const PortalLayout = dynamic(
  () => import("@/components/layout/PortalLayout").then((m) => ({ default: m.PortalLayout })),
  { ssr: false },
);
const WorkersStatusBanner = dynamic(
  () =>
    import("@/components/WorkersStatusBanner").then((m) => ({
      default: m.WorkersStatusBanner,
    })),
  { ssr: false },
);

/** Landing uses no shell; mission control is full-screen radar UI. */
export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/") return <>{children}</>;
  if (pathname === "/mission" || pathname.startsWith("/mission/")) {
    return (
      <>
        <WorkersStatusBanner deferMs={8_000} />
        {children}
      </>
    );
  }
  return <PortalLayout>{children}</PortalLayout>;
}
