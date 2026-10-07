/**
 * DB-backed accounting guards for the paper executor (findings H01, H02).
 *
 * These are the only tests in the suite that need a real Postgres, because both
 * bugs live in the gap between what the code READS and what it WRITES — a pure
 * unit test cannot reproduce a lost UPDATE race, and that race is the bug.
 *
 * They are SKIPPED unless TEST_DATABASE_URL is set, so `pnpm test` stays
 * database-free. Point it at a THROWAWAY database: every test truncates the
 * paper tables. Never point it at a database holding real paper results.
 *
 *   pnpm test:db   (see package.json)
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const skip = TEST_DB ? false : "TEST_DATABASE_URL not set";

// @spr/db reads DATABASE_URL at import time, so point it at the test database
// BEFORE the dynamic imports below. Never mutate a caller-supplied DATABASE_URL.
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

type Trading = typeof import("@spr/trading");
type Db = typeof import("@spr/db");

let trading: Trading;
let db: Db;

/** Fees on, latency and slippage off: this is an accounting test, not a fill test. */
function config(overrides: Partial<ReturnType<Trading["paperConfigFromEnv"]>> = {}) {
  return {
    ...trading.paperConfigFromEnv({} as NodeJS.ProcessEnv),
    enableLatency: false,
    enableSlippage: false,
    enableFees: true,
    priorityFeeSol: 0,
    maxPositionSol: 10,
    // H10 per-mint cap defaults to one position's worth; these tests open 1 SOL.
    maxPerMintSol: 10,
    maxOpenPositions: 50,
    dailyLossLimitSol: 1000,
    ...overrides,
  };
}

/**
 * H09 entry health. The gates FAIL CLOSED, so an accounting test must declare a
 * healthy system or it would be refused before the accounting under test ran.
 */
const HEALTHY = { breakerState: "RUNNING" as const, dataAgeMs: 100, feedDegraded: false };

const FLAT = 100;
const priceAt = (price: number) => async (mint: string) => ({ mint, price, referenceVSol: price });

describe("paper executor accounting", { skip }, () => {
  before(async () => {
    trading = await import("@spr/trading");
    db = await import("@spr/db");
  });

  beforeEach(async () => {
    await db.getPool().query(
      "TRUNCATE paper_trade_fills, paper_positions, paper_portfolio, paper_sessions RESTART IDENTITY CASCADE",
    );
    await trading.ensurePortfolio({ startSol: 10 });
  });

  after(async () => {
    await db.getPool().end();
  });

  it("H01: concurrent closes credit the balance exactly once", async () => {
    const cfg = config();
    const opened = await trading.openPosition({ mint: "H01", sizeSol: 1 }, cfg, priceAt(FLAT), HEALTHY);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const afterOpen = (await trading.loadPortfolio())!.balanceSol;

    // Both calls read state='OPEN' before either commits. Only one may settle.
    const results = await Promise.all([
      trading.closePosition({ positionId: opened.data.positionId, reason: "a" }, cfg, priceAt(FLAT)),
      trading.closePosition({ positionId: opened.data.positionId, reason: "b" }, cfg, priceAt(FLAT)),
    ]);

    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one close may succeed");

    const credited = (await trading.loadPortfolio())!.balanceSol - afterOpen;
    assert.ok(credited < 1.0, `credited ${credited} SOL for a 1 SOL position — double credit`);

    const fills = await db.getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM paper_trade_fills WHERE fill_type = 'CLOSE'",
    );
    assert.equal(Number(fills.rows[0]!.n), 1, "one CLOSE fill only");

    const pf = await db.getPool().query<{ wins: number; losses: number }>(
      "SELECT wins, losses FROM paper_portfolio WHERE id = 1",
    );
    assert.equal(pf.rows[0]!.wins + pf.rows[0]!.losses, 1, "win/loss counted once");
  });

  it("H02: a flat round trip costs exactly the entry fee plus the exit fee", async () => {
    const cfg = config();
    const feeRate = cfg.feeBps / 10_000;
    const size = 1;
    const before = (await trading.loadPortfolio())!.balanceSol;

    const opened = await trading.openPosition({ mint: "H02", sizeSol: size }, cfg, priceAt(FLAT), HEALTHY);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const closed = await trading.closePosition(
      { positionId: opened.data.positionId, reason: "flat" }, cfg, priceAt(FLAT),
    );
    assert.equal(closed.ok, true);
    if (!closed.ok) return;

    // Entry fee leaves first; the exit fee is charged on what the rest is worth;
    // and both legs pay the Solana base signature fee (M03), which neither
    // engine used to charge at all.
    const network = cfg.baseTxFeeSol * 2;
    const expected = -(size * feeRate) - size * (1 - feeRate) * feeRate - network;
    const delta = (await trading.loadPortfolio())!.balanceSol - before;

    assert.ok(
      Math.abs(delta - expected) < 1e-9,
      `balance moved ${delta}, expected ${expected} (entry fee lost: ${delta - expected})`,
    );
    assert.ok(
      Math.abs(closed.data.realizedPnlSol - expected) < 1e-9,
      `realized ${closed.data.realizedPnlSol}, expected ${expected}`,
    );
  });

  it("H02: realized PnL equals the balance change on a winner and a loser", async () => {
    const cfg = config();
    for (const [name, exit] of [["up", 150], ["down", 70]] as const) {
      await db.getPool().query(
        "TRUNCATE paper_trade_fills, paper_positions, paper_portfolio, paper_sessions RESTART IDENTITY CASCADE",
      );
      await trading.ensurePortfolio({ startSol: 10 });
      const before = (await trading.loadPortfolio())!.balanceSol;

      const opened = await trading.openPosition({ mint: `H02-${name}`, sizeSol: 1 }, cfg, priceAt(FLAT), HEALTHY);
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      const closed = await trading.closePosition(
        { positionId: opened.data.positionId, reason: name }, cfg, priceAt(exit),
      );
      assert.equal(closed.ok, true);
      if (!closed.ok) return;

      const delta = (await trading.loadPortfolio())!.balanceSol - before;
      assert.ok(
        Math.abs(delta - closed.data.realizedPnlSol) < 1e-9,
        `${name}: balance moved ${delta} but booked ${closed.data.realizedPnlSol}`,
      );
    }
  });

  it("H03: a fill prices the market AFTER the latency delay, not before it", async () => {
    // Fixed 60ms delay; the market moves at 20ms. A fill that quotes before
    // sleeping books the pre-move price it could never actually have got.
    const cfg = config({ enableLatency: true, latencyMinMs: 60, latencyMaxMs: 60 });
    let price = 100;
    const timer = setTimeout(() => { price = 150; }, 20);
    const moving = async (mint: string) => ({ mint, price, referenceVSol: price });

    const opened = await trading.openPosition({ mint: "H03", sizeSol: 1 }, cfg, moving, HEALTHY);
    clearTimeout(timer);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    assert.equal(
      opened.data.fillPrice, 150,
      `filled at ${opened.data.fillPrice}; the market was 150 by the time the order landed`,
    );
  });

  it("H02: a partial close then a full close still match the wallet exactly", async () => {
    const cfg = config();
    const before = (await trading.loadPortfolio())!.balanceSol;

    const opened = await trading.openPosition({ mint: "H02-partial", sizeSol: 1 }, cfg, priceAt(FLAT), HEALTHY);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const partial = await trading.partialClosePosition(
      { positionId: opened.data.positionId, fraction: 0.5, reason: "tp1" }, cfg, priceAt(120),
    );
    assert.equal(partial.ok, true);
    if (!partial.ok) return;

    const full = await trading.closePosition(
      { positionId: opened.data.positionId, reason: "rest" }, cfg, priceAt(120),
    );
    assert.equal(full.ok, true);
    if (!full.ok) return;

    const delta = (await trading.loadPortfolio())!.balanceSol - before;
    const booked = partial.data.realizedPnlSol + full.data.realizedPnlSol;
    assert.ok(
      Math.abs(delta - booked) < 1e-9,
      `balance moved ${delta} but booked ${booked} across the two legs`,
    );
  });

  it("M06/M07: every trade records its code version, config hash and measurement cleanliness", async () => {
    const cfg = config();
    const opened = await trading.openPosition({ mint: "PROV", sizeSol: 1 }, cfg, priceAt(FLAT), {
      ...HEALTHY,
      codeVersion: "deadbee",
      adaptiveSwitches: { autoTune: "on", shadowLearner: "off", autoContinuation: "off" },
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const row = await db.getPool().query<{ features: Record<string, unknown> }>(
      "SELECT entry_features AS features FROM paper_positions WHERE id = $1",
      [opened.data.positionId.toString()],
    );
    const f = row.rows[0]!.features;
    assert.equal(f.codeVersion, "deadbee");
    assert.match(String(f.configHash), /^[0-9a-f]{8}$/);
    assert.equal(f.measurementClean, false, "AUTO_TUNE was on — not measurement-grade");
    assert.deepEqual(f.adaptiveActive, ["AUTO_TUNE"]);
  });

  it("M07: provenance does not clobber the caller's own entry features", async () => {
    const cfg = config();
    const opened = await trading.openPosition(
      { mint: "PROV2", sizeSol: 1, entryFeatures: { research_strategy: "curveLadder", score: 7 } },
      cfg, priceAt(FLAT), { ...HEALTHY, codeVersion: "cafe123" },
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const row = await db.getPool().query<{ features: Record<string, unknown> }>(
      "SELECT entry_features AS features FROM paper_positions WHERE id = $1",
      [opened.data.positionId.toString()],
    );
    const f = row.rows[0]!.features;
    assert.equal(f.research_strategy, "curveLadder", "caller features must survive");
    assert.equal(f.score, 7);
    assert.equal(f.codeVersion, "cafe123");
  });
});
