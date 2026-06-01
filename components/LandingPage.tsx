import Link from "next/link";
import {
  Activity,
  BarChart3,
  LineChart,
  Radio,
  Shield,
  TrendingUp,
  Zap,
} from "lucide-react";

const FEATURES = [
  {
    icon: Radio,
    title: "Live trenches",
    description: "Pump.fun new, bonding, and graduated coins in a GMGN-style market view.",
  },
  {
    icon: Zap,
    title: "Signal feed",
    description: "Quality-scored BUY signals with smart-money and confluence filters.",
  },
  {
    icon: Activity,
    title: "Paper & live trade",
    description: "Demo wallet for practice, optional real wallet when you are ready.",
  },
  {
    icon: BarChart3,
    title: "Analytics",
    description: "Ingestor stats, performance, auto-trader sessions, and learning loops.",
  },
  {
    icon: LineChart,
    title: "Smart money",
    description: "Track wallets and clusters that consistently front-run pumps.",
  },
  {
    icon: Shield,
    title: "Local only",
    description: "Runs on your machine. No cloud account required for the dashboard.",
  },
] as const;

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500">
              <span className="font-bold text-white">P</span>
            </div>
            <span className="text-xl font-bold text-brand-600">Pump Radar</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/mission"
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:text-brand-600"
            >
              Mission control
            </Link>
            <Link href="/mission" className="btn-brand">
              Open radar
            </Link>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden bg-gradient-to-br from-brand-50 via-white to-brand-50">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center lg:py-28">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-brand-100 px-4 py-1.5 text-sm font-medium text-brand-700">
            <TrendingUp className="h-4 w-4" />
            Solana pump.fun analytics & trading
          </div>
          <h1 className="mb-6 text-4xl font-bold tracking-tight text-gray-900 lg:text-5xl">
            Your local
            <span className="mt-1 block text-brand-600">memecoin radar terminal</span>
          </h1>
          <p className="mx-auto mb-10 max-w-2xl text-lg text-gray-600">
            Research pump.fun tokens, follow signals, and paper-trade with the same workflow as a
            professional trading portal — entirely on localhost.
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link href="/mission" className="btn-brand-lg w-full sm:w-auto">
              Open mission control
            </Link>
            <Link href="/trade?guide=1" className="btn-outline-lg w-full sm:w-auto">
              Demo auto-trade
            </Link>
            <Link href="/paper" className="btn-outline-lg w-full sm:w-auto">
              Paper portfolio
            </Link>
          </div>
          <p className="mt-6 text-sm text-gray-500">
            Not financial advice. High risk of total loss. Personal research tool only.
          </p>
        </div>
      </section>

      <section className="border-t border-gray-100 bg-white py-20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold text-gray-900">Everything in one web app</h2>
            <p className="text-gray-600">Open in Visual Studio with F5 or run pnpm dev — same dashboard.</p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="card-portal">
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50">
                    <Icon className="h-5 w-5 text-brand-600" />
                  </div>
                  <h3 className="mb-2 font-semibold text-gray-900">{f.title}</h3>
                  <p className="text-sm text-gray-600">{f.description}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <footer className="border-t border-gray-200 bg-gray-50 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm text-gray-500 sm:flex-row">
          <span>Pump Radar — localhost web application</span>
          <Link href="/mission" className="font-medium text-brand-600 hover:text-brand-700">
            Open mission control →
          </Link>
        </div>
      </footer>
    </div>
  );
}
