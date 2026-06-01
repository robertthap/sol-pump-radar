-- Query perf for intelligence + signals (idempotent)

CREATE INDEX IF NOT EXISTS decision_log_ts_action_idx ON decision_log (ts DESC, action);
CREATE INDEX IF NOT EXISTS decision_log_executed_ts_idx ON decision_log (executed, ts DESC)
  WHERE executed = 'pending';
