-- Hot-path indexes for auto log + continuation console (idempotent)

CREATE INDEX IF NOT EXISTS paper_trades_entry_session_idx
  ON paper_trades ((entry_features->>'session_id'))
  WHERE status IN ('open', 'closed');

CREATE INDEX IF NOT EXISTS live_trades_session_opened_idx
  ON live_trades (session_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS continuation_candidates_updated_idx
  ON continuation_candidates (updated_at DESC);

CREATE INDEX IF NOT EXISTS continuation_events_ts_idx
  ON continuation_events (ts DESC);

CREATE INDEX IF NOT EXISTS decision_trace_stage_ts_idx
  ON decision_trace (stage, ts DESC)
  WHERE stage = 'intelligence_commit';
