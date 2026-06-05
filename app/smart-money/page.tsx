import { SmartMoneyPanel } from "@/components/SmartMoneyPanel";
import { WalletAnalyzer } from "@/components/WalletAnalyzer";
import { AdvancedPageShell } from "@/components/layout/AdvancedPageShell";

export default function SmartMoneyPage() {
  return (
    <AdvancedPageShell
      title="Smart money"
      description="Wallets with statistically strong closed-trade returns. Bump bots are filtered out."
    >
      <div className="space-y-3">
        <WalletAnalyzer />
        <SmartMoneyPanel />
      </div>
    </AdvancedPageShell>
  );
}
