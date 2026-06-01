import { PaperDashboard } from "@/components/paper/PaperDashboard";

export const dynamic = "force-dynamic";

export default function PaperPage() {
  return (
    <main className="min-h-screen bg-bg p-4 text-fg">
      <PaperDashboard />
    </main>
  );
}
