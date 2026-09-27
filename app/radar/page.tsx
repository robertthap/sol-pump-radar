"use client";

import { RadarScreen } from "@/components/radar/RadarScreen";

/**
 * /radar - the Coin Journey radar: the pipeline as it runs.
 * A div, not <main>: PortalLayout already renders the page's single <main> landmark.
 */
export default function RadarPage() {
  return (
    <div className="app-page app-page-wide">
      <RadarScreen />
    </div>
  );
}
