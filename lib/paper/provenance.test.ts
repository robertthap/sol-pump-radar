import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalConfig, configHash, measurementIntegrity, tradeProvenance,
  paperConfigFromEnv,
  type OutcomeAffectingConfig, type AdaptiveSwitches,
} from "@spr/trading";

/**
 * M06 / M07 — learners off during a measurement run, and the code version and
 * config hash recorded on every trade.
 *
 * Nothing recorded which code or which settings produced a trade. Across a
 * multi-day paper run the config does change, so a result was an average over
 * an unknown mixture of configurations that no later analysis can separate.
 */
const base: OutcomeAffectingConfig = {
  ...paperConfigFromEnv({} as NodeJS.ProcessEnv),
};
const allOff: AdaptiveSwitches = { autoTune: "off", shadowLearner: "off", autoContinuation: "off" };

describe("config hash (M07)", () => {
  it("is stable across runs and object key order", () => {
    const reordered = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as OutcomeAffectingConfig;
    assert.equal(configHash(base), configHash(reordered));
    assert.equal(configHash(base), configHash({ ...base }));
  });

  it("CHANGES when anything that moves a trade's outcome changes", () => {
    const h = configHash(base);
    assert.notEqual(configHash({ ...base, feeBps: base.feeBps + 1 }), h);
    assert.notEqual(configHash({ ...base, priorityFeeSol: 0.001 }), h);
    assert.notEqual(configHash({ ...base, baseSlippageBps: 50 }), h);
    assert.notEqual(configHash({ ...base, enableFees: !base.enableFees }), h);
    assert.notEqual(configHash({ ...base, maxDrawdownPct: 0.9 }), h);
    assert.notEqual(configHash({ ...base, latencyMaxMs: 9999 }), h);
  });

  it("does NOT change for a cosmetic field, so runs stay comparable", () => {
    const withExtra = { ...base, someNewUnrelatedField: 42 } as unknown as OutcomeAffectingConfig;
    assert.equal(configHash(withExtra), configHash(base));
  });

  it("is short, hex and fixed-width, so it can sit on every row", () => {
    assert.match(configHash(base), /^[0-9a-f]{8}$/);
  });

  it("the canonical text names every hashed key, so a reader can see what it covers", () => {
    const text = canonicalConfig(base);
    for (const k of ["feeBps", "priorityFeeSol", "maxPerMintSol", "enableLatency"]) {
      assert.ok(text.includes(`${k}=`), `${k} missing from the canonical text`);
    }
  });
});

describe("measurement integrity (M06)", () => {
  it("all learners off is clean", () => {
    const r = measurementIntegrity(allOff);
    assert.equal(r.clean, true);
    assert.deepEqual(r.active, []);
  });

  it("names each adaptive component that is still running", () => {
    assert.deepEqual(measurementIntegrity({ ...allOff, autoTune: "on" }).active, ["AUTO_TUNE"]);
    assert.deepEqual(
      measurementIntegrity({ autoTune: "on", shadowLearner: "on", autoContinuation: "on" }).active,
      ["AUTO_TUNE", "SHADOW_LEARNER", "AUTO_CONTINUATION"],
    );
  });

  it("anything not explicitly 'off' counts as ON", () => {
    // An unset or misspelled value must not read as disabled.
    assert.equal(measurementIntegrity({ ...allOff, autoTune: undefined }).clean, false);
    assert.equal(measurementIntegrity({ ...allOff, autoTune: "" }).clean, false);
    assert.equal(measurementIntegrity({ ...allOff, autoTune: "OFF" }).clean, false);
    assert.equal(measurementIntegrity({ ...allOff, shadowLearner: "false" }).clean, false);
  });

  it("this repo's own defaults are a clean measurement configuration", () => {
    // AUTO_TUNE, SHADOW_LEARNER and AUTO_CONTINUATION all default to "off".
    assert.equal(measurementIntegrity(allOff).clean, true);
  });
});

describe("trade provenance (M06+M07 together)", () => {
  it("stamps code version, config hash and measurement cleanliness", () => {
    const p = tradeProvenance({ codeVersion: "abc1234", config: base, switches: allOff });
    assert.equal(p.codeVersion, "abc1234");
    assert.match(p.configHash, /^[0-9a-f]{8}$/);
    assert.equal(p.measurementClean, true);
    assert.deepEqual(p.adaptiveActive, []);
  });

  it("marks a trade NOT measurement-grade when a learner was running", () => {
    const p = tradeProvenance({
      codeVersion: "abc1234", config: base,
      switches: { ...allOff, autoTune: "on" },
    });
    assert.equal(p.measurementClean, false);
    assert.deepEqual(p.adaptiveActive, ["AUTO_TUNE"]);
  });

  it("an absent code version is recorded as 'unknown', never blank", () => {
    assert.equal(tradeProvenance({ codeVersion: undefined, config: base, switches: allOff }).codeVersion, "unknown");
    assert.equal(tradeProvenance({ codeVersion: "   ", config: base, switches: allOff }).codeVersion, "unknown");
  });
});
