import "server-only";
import type { IntelligenceEngine, IntelligenceInputSnapshot } from "@/lib/intelligence/types";
import { engineAEligible, engineBEligible } from "@/lib/intelligence/normalized-adapter";

export function selectEngine(input: IntelligenceInputSnapshot): IntelligenceEngine {
  if (input.migration_status === "curve" && engineAEligible(input)) return "A";
  if (engineBEligible(input)) return "B";
  if (engineAEligible(input)) return "A";
  return "B";
}
