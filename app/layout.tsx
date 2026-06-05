import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "./providers";
import { ModeBanner } from "@/components/runtime/ModeBanner";

export const metadata: Metadata = {
  title: "Pump Radar",
  description: "Localhost Solana pump.fun analytics and paper trading web application.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ModeBanner />
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
