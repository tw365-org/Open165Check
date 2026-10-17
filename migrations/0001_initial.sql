PRAGMA foreign_keys = ON;
CREATE TABLE runs (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
 dataset_name TEXT NOT NULL, dataset_hash TEXT NOT NULL, config_version TEXT NOT NULL,
 config_json TEXT NOT NULL, requested_model TEXT NOT NULL, models_json TEXT NOT NULL DEFAULT '[]',
 threshold REAL NOT NULL, status TEXT NOT NULL, n_total INTEGER NOT NULL,
 n_completed INTEGER NOT NULL DEFAULT 0, n_errors INTEGER NOT NULL DEFAULT 0,
 n_unfinished INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, summary_json TEXT
);
CREATE TABLE results (
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, sample_id TEXT NOT NULL,
 label TEXT NOT NULL, category TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', text TEXT,
 choice TEXT, p_scam REAL, probs_json TEXT, signals_json TEXT, actual_model TEXT,
 latency_ms REAL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, completed_at TEXT,
 PRIMARY KEY(run_id, sample_id)
);
CREATE INDEX runs_created ON runs(created_at DESC, id DESC);
CREATE INDEX results_run ON results(run_id, completed_at);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
 run_id TEXT, status TEXT NOT NULL, latency_ms REAL,
 input_tokens INTEGER, output_tokens INTEGER
);
CREATE INDEX audit_created ON audit_events(created_at);
CREATE TABLE rate_counters (
 key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE quota_leases (
 id TEXT PRIMARY KEY, ip_key TEXT NOT NULL, day_key TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER consume_quota AFTER INSERT ON quota_leases BEGIN
 UPDATE rate_counters SET count = count + 1 WHERE key IN (NEW.ip_key, NEW.day_key);
END;
