"use client";

import { TickerProvider } from "@/components/ticker/TickerProvider";
import { PnlHero } from "@/components/ticker/PnlHero";
import { PositionList } from "@/components/ticker/PositionList";
import { BotControls } from "@/components/ticker/BotControls";
import { LiveLog } from "@/components/ticker/LiveLog";

/**
 * /trade - the minimal terminal.
 *
 *   TickerProvider           one poll -> /api/ticker
 *     PnlHero (+ sparkline)  how much am I in, am I up or down
 *     PositionList           what is open, Sell / Sell all
 *     BotControls            is the bot running, limits, Start / Stop
 *     LiveLog                what just happened to my capital
 *
 * Desktop: hero, then positions beside the bot panel, then the log.
 * Mobile:  hero, bot controls, positions, log (CSS order, no duplication).
 * ModeGate (demo/real chooser) is mounted globally by the app providers.
 */
export default function TradePage() {
  return (
    <TickerProvider>
      <main className="app-page space-y-3">
        <PnlHero />
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="order-2 min-w-0 md:order-1">
            <PositionList />
          </div>
          <div className="order-1 md:order-2">
            <BotControls />
          </div>
        </div>
        <LiveLog />
      </main>
    </TickerProvider>
  );
}
