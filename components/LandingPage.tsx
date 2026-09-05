"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Play, ShieldCheck, Wallet, ArrowRight } from "lucide-react";
import { useTradingMode } from "@/components/TradingModeProvider";

const RealModeGate = dynamic(
  () => import("@/components/RealModeGate").then((m) => ({ default: m.RealModeGate })),
  { ssr: false },
);

/**
 * Homepage = wallet chooser. Pick Demo (paper) or Real (live wallet); either sets
 * the trading mode and drops you straight into the auto-trade desk (/trade).
 */
export function LandingPage() {
  const router = useRouter();
  const { mode, activeSession, setMode, exitSession } = useTradingMode();
  const [busy, setBusy] = useState<"demo" | "real" | null>(null);
  const [realGateOpen, setRealGateOpen] = useState(false);
  const [logOffBusy, setLogOffBusy] = useState(false);
  // `mode` hydrates from localStorage on the client, so it differs from the server's
  // null on first paint. Gate mode-dependent UI until mounted to avoid a hydration
  // mismatch (server + first client render both see mounted=false).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const enterDemo = async () => {
    setBusy("demo");
    try {
      await setMode("demo");
      router.push("/trade");
    } catch {
      setBusy(null);
    }
  };

  const enterReal = async () => {
    setBusy("real");
    try {
      await setMode("real");
      router.push("/trade");
    } catch {
      setBusy(null);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-bg text-fg">
      <RealModeGate
        open={realGateOpen}
        onCancel={() => {
          setRealGateOpen(false);
          setBusy(null);
        }}
        onConfirm={() => {
          setRealGateOpen(false);
          void enterReal();
        }}
      />
      {/* ambient glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, rgb(22 199 132 / 0.10), transparent 70%)",
        }}
      />

      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-3xl flex-col items-center justify-center px-4 py-10 sm:px-5 sm:py-12">
        {/* brand */}
        <div className="mb-8 flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500">
            <span className="text-lg font-bold text-black">P</span>
          </div>
          <span className="text-2xl font-bold tracking-tight">
            Pump<span className="text-accent">Radar</span>
          </span>
        </div>

        <h1 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
          Choose a wallet to start trading
        </h1>
        <p className="mt-2 max-w-md text-center text-sm text-muted">
          A local pump.fun auto-trading terminal. Practice risk-free with a demo wallet, or connect a
          real wallet when you&apos;re ready.
        </p>

        {mounted && mode != null && activeSession && (
          <div className="mt-6 flex w-full max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-panel/80 px-4 py-3 text-center text-xs">
            <p className="text-muted">
              You have an active{" "}
              <span className={mode === "demo" ? "font-semibold text-accent" : "font-semibold text-warn"}>
                {mode === "demo" ? "demo" : "real"}
              </span>{" "}
              session. Continue trading or log off to pick a different wallet.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                className="btn btn-ghost border border-accent/40 text-accent"
                onClick={() => router.push("/trade")}
              >
                Continue session
              </button>
              <button
                type="button"
                className="btn btn-ghost text-muted"
                disabled={logOffBusy}
                onClick={() => {
                  setLogOffBusy(true);
                  void exitSession().finally(() => setLogOffBusy(false));
                }}
              >
                {logOffBusy ? "Logging off…" : "Log off"}
              </button>
            </div>
          </div>
        )}

        {/* wallet chooser */}
        <div className="mt-9 grid w-full gap-4 sm:grid-cols-2">
          {/* Demo */}
          <button
            type="button"
            onClick={() => void enterDemo()}
            disabled={busy != null}
            className="group flex flex-col items-start gap-3 rounded-2xl border border-accent/30 bg-panel p-5 text-left transition-colors hover:border-accent/70 disabled:opacity-60"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Play className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold">Demo wallet</span>
            <span className="text-xs text-muted">
              Play money, simulated fills. Safe to experiment — no crypto at risk. Starts with 10 SOL.
            </span>
            <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-accent">
              {busy === "demo" ? "Opening…" : "Start in demo"} <ArrowRight className="h-4 w-4" />
            </span>
          </button>

          {/* Real */}
          <button
            type="button"
            onClick={() => {
              setBusy("real");
              setRealGateOpen(true);
            }}
            disabled={busy != null}
            className="group flex flex-col items-start gap-3 rounded-2xl border border-border bg-panel p-5 text-left transition-colors hover:border-warn/60 disabled:opacity-60"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-warn/15 text-warn">
              <Wallet className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold">Real wallet</span>
            <span className="text-xs text-muted">
              Your connected wallet trades on-chain. Live orders fire only when the runtime profile and
              caps allow. Confirmation required.
            </span>
            <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-warn">
              Connect real wallet <ArrowRight className="h-4 w-4" />
            </span>
          </button>
        </div>

        <p className="mt-8 flex items-center gap-1.5 text-center text-[11px] text-muted">
          <ShieldCheck className="h-3.5 w-3.5" />
          Runs locally. Not financial advice — high risk of total loss. Personal research tool only.
        </p>
      </div>
    </div>
  );
}
