CREATE TABLE IF NOT EXISTS research_episodes (
  session_id bigint NOT NULL,
  episode_key text NOT NULL,
  mint text NOT NULL,
  strategy text NOT NULL,
  decision_ts timestamptz NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  features jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, episode_key)
);
CREATE INDEX IF NOT EXISTS research_episodes_session_ts_idx ON research_episodes(session_id, decision_ts DESC);
