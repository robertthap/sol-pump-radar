"use client";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { TradingModeProvider } from "@/components/TradingModeProvider";
import { AppChrome } from "@/components/layout/AppChrome";
import { RuntimePerfBeacon } from "@/components/RuntimePerfBeacon";
import { phantomConnectEnabled } from "@/lib/phantom/config";

const PhantomConnectRoot = dynamic(
  () =>
    import("@/components/phantom/PhantomConnectRoot").then((m) => ({
      default: m.PhantomConnectRoot,
    })),
  { ssr: false },
);

const ChunkLoadRecovery = dynamic(
  () =>
    import("@/components/ChunkLoadRecovery").then((m) => ({
      default: m.ChunkLoadRecovery,
    })),
  { ssr: false },
);
const ModeGate = dynamic(
  () => import("@/components/ModeGate").then((m) => ({ default: m.ModeGate })),
  { ssr: false },
);

export function AppProviders({ children }: { children: ReactNode }) {
  const inner = (
    <TradingModeProvider>
      <RuntimePerfBeacon />
      <ChunkLoadRecovery />
      <ModeGate />
      <AppChrome>{children}</AppChrome>
    </TradingModeProvider>
  );

  if (phantomConnectEnabled()) {
    return <PhantomConnectRoot>{inner}</PhantomConnectRoot>;
  }

  return inner;
}
