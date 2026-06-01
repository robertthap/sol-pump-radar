import { ClustersPanel } from "@/components/ClustersPanel";
import { AdvancedPageShell } from "@/components/layout/AdvancedPageShell";

export default function RingsPage() {
  return (
    <AdvancedPageShell
      title="Wallet rings"
      description="Coordinated wallet groups that buy together across launches — treat matching buyers as a red flag."
    >
      <ClustersPanel />
    </AdvancedPageShell>
  );
}
