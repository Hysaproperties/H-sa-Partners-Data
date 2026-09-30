CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  ua TEXT,
  referer TEXT
);
CREATE INDEX IF NOT EXISTS clicks_partner_ts ON clicks (partner_id, ts);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mime TEXT,
  data TEXT,
  created_at TEXT
);
