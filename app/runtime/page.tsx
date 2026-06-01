import { RuntimeHealthDashboard } from "@/components/runtime/RuntimeHealthDashboard";

export const dynamic = "force-dynamic";

export default function RuntimePage() {
  return (
    <main className="min-h-screen bg-bg p-4 text-fg">
      <RuntimeHealthDashboard />
    </main>
  );
}
