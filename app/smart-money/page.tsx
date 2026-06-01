import { SmartMoneyPanel } from "@/components/SmartMoneyPanel";
import { AdvancedPageShell } from "@/components/layout/AdvancedPageShell";

export default function SmartMoneyPage() {
  return (
    <AdvancedPageShell
      title="Smart money"
      description="Wallets with statistically strong closed-trade returns. Bump bots are filtered out."
    >
      <SmartMoneyPanel />
    </AdvancedPageShell>
  );
}
