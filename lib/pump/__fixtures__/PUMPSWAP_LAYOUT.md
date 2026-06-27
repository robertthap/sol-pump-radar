# PumpSwap (pump-amm) swap event layout — T1.2a discovery (2026-06-21)

Discovered + validated against on-chain ground truth (user pubkey, SOL balance delta,
token balance delta) using real transactions from wallet `7Ts3yn7m…`. Fixtures in
`pumpswap-swaps.json` (2 user-buys + 2 user-sells). **No guessed offsets** — every
field below was cross-checked against `getTransaction` meta balances.

## Program
- `PUMP_SWAP_AMM_PROGRAM = pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

## Events (Anchor `emit!` → `Program data:` log lines, same mechanism as curve TradeEvent)
- `event:BuyEvent`  discriminator `67 f4 52 1f 2c f5 77 77` (body 385 bytes)
- `event:SellEvent` discriminator `3e 2f 37 0a a5 03 dc 2a` (body 352 bytes)

## Field layout (after the 8-byte discriminator), little-endian
| off | type | BuyEvent | SellEvent |
|----:|------|----------|-----------|
| 0 | i64 | timestamp | timestamp |
| 8 | u64 | base_amount_out | base_amount_in |
| 16 | u64 | max_quote_amount_in | min_quote_amount_out |
| 24 | u64 | user_base_token_reserves | user_base_token_reserves |
| 32 | u64 | user_quote_token_reserves | user_quote_token_reserves |
| 40 | u64 | **pool_base_token_reserves** | **pool_base_token_reserves** |
| 48 | u64 | **pool_quote_token_reserves** | **pool_quote_token_reserves** |
| 56 | u64 | quote_amount_in | quote_amount_out |
| 64 | u64 | lp_fee_basis_points | lp_fee_basis_points |
| 72 | u64 | lp_fee | lp_fee |
| 80 | u64 | protocol_fee_basis_points | protocol_fee_basis_points |
| 88 | u64 | protocol_fee | protocol_fee |
| 96 | u64 | quote_amount_in_with_lp_fee | quote_amount_out_without_lp_fee |
| 104 | u64 | user_quote_amount_in | user_quote_amount_out |
| 112 | pubkey | **pool** | **pool** |
| 144 | pubkey | **user** | **user** |
| 176+ | … | more pubkeys (fee recipients, coin_creator) — not needed | … |

`base_amount` (off 8) and `quote_amount` (off 56) are the gross swap legs in BASE /
QUOTE token units respectively. **Which is SOL vs the meme token depends on the pool's
base/quote mint ordering** — the event does NOT carry the mints.

## Pool → mint resolution (required; immutable per pool, cacheable)
Read the pool account (same as `lib/chart/data/onchainPrice.ts`):
- base_mint  @ absolute offset 43 (32 bytes)
- quote_mint @ absolute offset 75 (32 bytes)
- `baseIsWsol = base_mint === So111…112`
- `memeMint = baseIsWsol ? quote_mint : base_mint`

## Deriving the canonical trade record
- `solAmount   = baseIsWsol ? base_amount : quote_amount`
- `tokenAmount = baseIsWsol ? quote_amount : base_amount`
- `solReserveAfter = baseIsWsol ? pool_base_token_reserves : pool_quote_token_reserves`
- `tokenReserveAfter = baseIsWsol ? pool_quote_token_reserves : pool_base_token_reserves`

## User side (validated against SOL balance-delta sign in all 4 fixtures)
The event type is the POOL's action, not the user's:
- `userReceivesMeme = (BuyEvent && !baseIsWsol) || (SellEvent && baseIsWsol)`
- `userSide = userReceivesMeme ? "buy" : "sell"`
- Cross-check: SOL delta < 0 ⟺ user bought meme. Matched in every fixture.

## Effective vSol (for cross-graduation PnL/label continuity)
Spot price (SOL per token) = `solReserveAfter / tokenReserveAfter` (constant product).
mcap_usd = price × SOL_USD × PUMP_SUPPLY, then `effectiveVSolFromMcapUsd(mcap_usd)`
(see `lib/dex/curve-mcap.ts`). Store the effective vSol — never raw USD — so the
vSol²-basis PnL stays continuous across the graduation boundary.

## Architecture note
The pure log parser (`parseSwapLogs`) extracts the raw fields above (sync, fixture-
testable). The pool→mint resolution + SOL-price → effective-vSol enrichment is async
(RPC + cached SOL price) and happens in the ingestor, mirroring the curve flush path.
