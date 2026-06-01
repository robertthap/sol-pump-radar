import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * Architecture barrier:
 *   web (app/**, components/**) MUST NOT import modules that can execute trades,
 *   sign transactions, or drive the worker runtime. These are the truly
 *   dangerous paths — the architectural contradictions the cutover is closing.
 *
 *   Banned for web:
 *   - @/lib/executor/live              - live signing + RPC submission
 *   - @/lib/executor/paper             - legacy paper writer
 *   - @/lib/workers/auto-trader        - trade decision + execution loop
 *   - @/lib/workers/trader             - legacy trader loop
 *   - @/lib/workers/orchestrator       - boots all worker lanes
 *   - @/lib/workers/live-execution-listener - processes LIVE_TRADE_INTENT
 *   - @/lib/paper/engine               - paperOpen / paperClose / paperReset (writes)
 *   - @/lib/paper/mtm-lane             - mark-to-market loop
 *   - @/lib/paper/reset-listener       - reset processor
 *   - @/lib/wallet/worker-vault        - worker-side passphrase unlock
 *   - @/lib/runtime/worker-lock        - advisory-lock singleton
 *   - apps/worker/**                   - canonical worker runtime
 *
 *   For Phantom helpers (no server keypair) use @/lib/executor/live-phantom.
 *   For wallet status display, web still imports @/lib/wallet/session (read
 *   helpers only; the executor barrier above prevents any signing path).
 *   That softer boundary is part of the staged cutover.
 */
const WORKER_ONLY_PATTERNS = [
  "@/lib/executor/live",
  "@/lib/executor/paper",
  "@/lib/workers/auto-trader",
  "@/lib/workers/trader",
  "@/lib/workers/orchestrator",
  "@/lib/workers/live-execution-listener",
  "@/lib/workers/paper-trade-listener",
  "@/lib/workers/demo-reset-listener",
  "@/lib/workers/web-command-listener",
  "@/lib/workers/phantom-live-listener",
  "@/lib/paper/engine",
  "@/lib/paper/mtm-lane",
  "@/lib/paper/reset-listener",
  "@/lib/wallet/worker-vault",
  "@/lib/runtime/worker-lock",
  "apps/worker/*",
  "apps/worker/**",
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "drizzle/**",
      "data/**",
      "host/**",
      "obj/**",
      "next-env.d.ts",
      "packages/**",
      "apps/**",
    ],
  },
  // Web (API routes): mutations only through the web-write gate.
  {
    files: ["app/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@spr/db",
              message:
                "API routes: use @/lib/runtime/postgres-read for reads and @/lib/runtime/web-writes for allowlisted mutations.",
            },
          ],
          patterns: WORKER_ONLY_PATTERNS.map((pattern) => ({
            group: [pattern],
            message:
              "Web cannot import worker-only modules. Submit a command via executeWebMutation and let the worker act on it.",
          })),
        },
      ],
    },
  },
  // Web (pages + components): no worker imports anywhere.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: ["app/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: WORKER_ONLY_PATTERNS.map((pattern) => ({
            group: [pattern],
            message:
              "UI cannot import worker-only modules. Read state from /api/* and submit commands via /api/* routes.",
          })),
        },
      ],
    },
  },
];

export default eslintConfig;
