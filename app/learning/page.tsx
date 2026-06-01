import { LearningPanel } from "@/components/LearningPanel";
import { LearnedRulesPanel } from "@/components/LearnedRulesPanel";
import { RugInsightsPanel } from "@/components/RugInsightsPanel";

export default function LearningPage() {
  return (
    <main className="mx-auto max-w-[1600px] px-4 pb-24">
      <div className="mb-3">
        <h1 className="text-base font-semibold tracking-tight">Learning</h1>
        <p className="text-[11px] text-muted">
          How the system is improving from each trade. Threshold auto-tuner, loss postmortems,
          learned avoid rules, and pump-trap analysis from rugged coins.
        </p>
      </div>
      <div className="mb-3">
        <RugInsightsPanel />
      </div>
      <div className="mb-3">
        <LearningPanel />
      </div>
      <LearnedRulesPanel />
    </main>
  );
}
