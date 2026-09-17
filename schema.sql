-- GTS DMARC aggregate report store.
-- Apply with: npm run db:init   (add :local for the dev database)

-- One row per aggregate report received. report_id is the reporter's own id and is
-- the idempotency key: reporters resend, and Email Routing can redeliver.
CREATE TABLE IF NOT EXISTS reports (
  report_id      TEXT PRIMARY KEY,
  org_name       TEXT NOT NULL,
  org_email      TEXT,
  domain         TEXT NOT NULL,
  date_begin     INTEGER NOT NULL,
  date_end       INTEGER NOT NULL,
  policy_p       TEXT,
  policy_sp      TEXT,
  policy_pct     INTEGER,
  policy_adkim   TEXT,
  policy_aspf    TEXT,
  received_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_domain_end ON reports (domain, date_end);

-- One row per <record> inside a report: a sending source and its alignment results.
CREATE TABLE IF NOT EXISTS records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id      TEXT NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
  domain         TEXT NOT NULL,
  source_ip      TEXT NOT NULL,
  count          INTEGER NOT NULL,
  disposition    TEXT,
  dkim_aligned   INTEGER NOT NULL,
  spf_aligned    INTEGER NOT NULL,
  header_from    TEXT,
  dkim_domain    TEXT,
  spf_domain     TEXT,
  date_end       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_domain_end ON records (domain, date_end);
CREATE INDEX IF NOT EXISTS idx_records_source ON records (domain, source_ip);

-- Domain -> Halo client. Synced FROM Halo; Halo is the source of record.
-- source: 'halo' for synced rows, 'local' for the few Halo cannot express.
CREATE TABLE IF NOT EXISTS domain_map (
  domain         TEXT PRIMARY KEY,
  client_id      INTEGER,
  client_name    TEXT,
  source         TEXT NOT NULL DEFAULT 'halo',
  updated_at     INTEGER NOT NULL
);

-- Domains that sent reports but match no client. This is the audit of missing
-- Email Domains values, produced as a side effect of ingest.
CREATE TABLE IF NOT EXISTS unmapped (
  domain         TEXT PRIMARY KEY,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  report_count   INTEGER NOT NULL DEFAULT 1
);

-- First time each (domain, source_ip) pair appeared, so "new sending source"
-- means new, not merely "failing today".
CREATE TABLE IF NOT EXISTS source_seen (
  domain         TEXT NOT NULL,
  source_ip      TEXT NOT NULL,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  label          TEXT,
  alerted_at     INTEGER,
  PRIMARY KEY (domain, source_ip)
);
