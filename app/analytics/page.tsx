import { AnalyticsClient } from "@/components/AnalyticsPage";
import { TradeLimitsEditor } from "@/components/TradeLimitsEditor";
import { LearningPanel } from "@/components/LearningPanel";
import { ShadowParityPanel } from "@/components/ShadowParityPanel";

export default function AnalyticsPage() {
  return (
    <>
      <div className="app-page app-page-wide !pt-0">
        <section className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <LearningPanel />
          </div>
          <div>
            <TradeLimitsEditor />
          </div>
        </section>
        <section className="mb-3">
          <ShadowParityPanel hours={24} />
        </section>
      </div>
      <AnalyticsClient />
    </>
  );
}
