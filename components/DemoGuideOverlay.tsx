"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useTradingMode } from "@/components/TradingModeProvider";

const STEPS = [
  {
    title: "Pick Demo mode",
    body: "Use play money (10 SOL virtual wallet). No crypto wallet or real funds needed.",
  },
  {
    title: "Press Start auto-trade",
    body: "The bot buys strong signals for you and sells at take-profit or stop-loss automatically.",
  },
  {
    title: "Watch the live log",
    body: "Scroll the log below to see every open, close, and skip in real time.",
  },
] as const;

const GLOSSARY: Array<{ term: string; plain: string }> = [
  { term: "SOL", plain: "Solana currency — like dollars for this app" },
  { term: "Signal strength (conf)", plain: "How confident the bot is — higher is better" },
  { term: "Pool size (v_sol)", plain: "How much money is in the coin's bonding curve" },
  { term: "Take profit / Stop loss", plain: "Auto-sell when up ~40% or down ~15%" },
  { term: "Rug", plain: "Scam coin where creators steal liquidity" },
];

export function DemoGuideOverlay() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { mode, needsSelection, setMode, loading } = useTradingMode();
  const [step, setStep] = useState(0);
  const [showGlossary, setShowGlossary] = useState(false);
  const guided = searchParams.get("guide") === "1";

  const dismiss = useCallback(() => {
    router.replace("/trade");
  }, [router]);

  useEffect(() => {
    if (!guided) return;
    if (!loading && mode === "demo" && !needsSelection && step < STEPS.length - 1) {
      setStep(2);
    }
  }, [guided, loading, mode, needsSelection, step]);

  if (!guided) return null;

  async function pickDemo() {
    await setMode("demo");
    setStep(1);
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-gray-900/50 p-4 sm:items-center">
      <div className="card w-full max-w-md p-5 shadow-xl">
        <p className="mb-1 text-[10px] uppercase tracking-wide text-accent">Quick start</p>
        <h2 className="mb-3 text-lg font-semibold">{STEPS[step]?.title ?? "Ready"}</h2>
        <p className="mb-4 text-sm text-muted">{STEPS[step]?.body}</p>

        <ol className="mb-4 space-y-2">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className={`flex gap-2 text-xs ${i === step ? "text-fg" : "text-muted"}`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  i <= step ? "bg-ok/20 text-ok" : "bg-panel text-muted"
                }`}
              >
                {i + 1}
              </span>
              {s.title}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <button type="button" className="btn btn-buy mb-2 w-full py-2" onClick={() => void pickDemo()}>
            Use Demo — play money
          </button>
        )}
        {step >= 1 && (
          <p className="mb-3 text-xs text-ok">
            Demo selected — press the green <b>Start auto-trade</b> button above.
          </p>
        )}

        <button
          type="button"
          className="mb-3 text-xs text-accent underline-offset-2 hover:underline"
          onClick={() => setShowGlossary((v) => !v)}
        >
          {showGlossary ? "Hide" : "Show"} plain-language glossary
        </button>
        {showGlossary && (
          <ul className="mb-4 max-h-40 space-y-1 overflow-auto text-[11px] text-muted">
            {GLOSSARY.map((g) => (
              <li key={g.term}>
                <span className="text-fg">{g.term}</span> — {g.plain}
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost flex-1" onClick={dismiss}>
            Got it
          </button>
          {step < STEPS.length - 1 && step > 0 && (
            <button type="button" className="btn btn-ghost flex-1" onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
