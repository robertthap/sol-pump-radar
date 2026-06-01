"use client";

import type { ReactNode } from "react";
import { PhantomProvider, darkTheme, AddressType } from "@phantom/react-sdk";
import { phantomAppId, phantomConnectEnabled } from "@/lib/phantom/config";

export function PhantomConnectRoot({ children }: { children: ReactNode }) {
  if (!phantomConnectEnabled()) {
    return <>{children}</>;
  }

  const appId = phantomAppId();
  return (
    <PhantomProvider
      config={{
        providers: ["injected", "google", "apple"],
        appId,
        addressTypes: [AddressType.solana],
        authOptions: {
          redirectUrl:
            typeof window !== "undefined"
              ? `${window.location.origin}/trade`
              : "http://127.0.0.1:3000/trade",
        },
      }}
      theme={darkTheme}
    >
      {children}
    </PhantomProvider>
  );
}
