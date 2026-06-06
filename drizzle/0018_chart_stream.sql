CREATE TABLE IF NOT EXISTS chart_stream_state (
  mint TEXT PRIMARY KEY,
  epoch INT NOT NULL DEFAULT 1,
  last_trade_id BIGINT NOT NULL DEFAULT 0,
  last_seq INT NOT NULL DEFAULT 0,
  graduation_at TIMESTAMPTZ,
  regime TEXT NOT NULL DEFAULT 'bonding_curve',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mint_dex_quotes (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  price_usd DOUBLE PRECISION NOT NULL,
  mcap_usd DOUBLE PRECISION,
  source TEXT NOT NULL,
  UNIQUE (mint, ts, source)
);

CREATE INDEX IF NOT EXISTS mint_dex_quotes_mint_ts_idx ON mint_dex_quotes (mint, ts DESC);

CREATE TABLE IF NOT EXISTS chart_candle_checkpoints (
  mint TEXT NOT NULL,
  tf TEXT NOT NULL,
  epoch INT NOT NULL,
  last_trade_id BIGINT NOT NULL,
  candles_json JSONB NOT NULL,
  checksum TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, tf)
);

CREATE INDEX IF NOT EXISTS events_mint_id_idx ON events (mint, id);
