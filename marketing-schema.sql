-- Bright Clean Marketing & Growth additive schema. SQLite / better-sqlite3.
-- Run via a versioned migration; do not drop or recreate existing business tables.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS marketing_campaigns (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, channel TEXT NOT NULL,
 objective TEXT NOT NULL DEFAULT 'lead_generation', service_key TEXT, service_label TEXT,
 target_locations TEXT NOT NULL DEFAULT '[]', audience TEXT, landing_path TEXT,
 budget_amount REAL NOT NULL DEFAULT 0 CHECK(budget_amount>=0), budget_period TEXT NOT NULL DEFAULT 'monthly',
 currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'draft',
 starts_at TEXT, ends_at TEXT, owner_email TEXT, approval_status TEXT NOT NULL DEFAULT 'not_required',
 provider TEXT, provider_account_id TEXT, provider_campaign_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status ON marketing_campaigns(status);
CREATE TABLE IF NOT EXISTS marketing_attribution (
 id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL UNIQUE,
 first_source TEXT, first_medium TEXT, first_campaign TEXT, first_campaign_id INTEGER,
 first_content TEXT, first_term TEXT, first_landing_path TEXT, first_referrer TEXT,
 first_click_id TEXT, first_click_id_type TEXT, first_touch_at TEXT,
 latest_source TEXT, latest_medium TEXT, latest_campaign TEXT, latest_campaign_id INTEGER,
 latest_content TEXT, latest_term TEXT, latest_landing_path TEXT, latest_referrer TEXT,
 latest_click_id TEXT, latest_click_id_type TEXT, latest_touch_at TEXT,
 attribution_model TEXT NOT NULL DEFAULT 'first_and_last_touch', consent_state TEXT NOT NULL DEFAULT 'unknown',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
 FOREIGN KEY(first_campaign_id) REFERENCES marketing_campaigns(id),
 FOREIGN KEY(latest_campaign_id) REFERENCES marketing_campaigns(id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_attr_campaign ON marketing_attribution(first_campaign_id,latest_campaign_id);
CREATE TABLE IF NOT EXISTS marketing_touchpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, campaign_id INTEGER,
 event_type TEXT NOT NULL, source TEXT, medium TEXT, campaign_name TEXT, content TEXT, term TEXT,
 landing_path TEXT, referrer TEXT, click_id TEXT, click_id_type TEXT, occurred_at TEXT NOT NULL,
 metadata_json TEXT NOT NULL DEFAULT '{}',
 FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
 FOREIGN KEY(campaign_id) REFERENCES marketing_campaigns(id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_touchpoints_lead ON marketing_touchpoints(lead_id,occurred_at);
CREATE TABLE IF NOT EXISTS marketing_content (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, title TEXT NOT NULL, content_type TEXT NOT NULL,
 channel TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', media_json TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'draft', scheduled_at TEXT, published_at TEXT,
 provider TEXT, provider_post_id TEXT, created_by TEXT, approved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(campaign_id) REFERENCES marketing_campaigns(id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_content_schedule ON marketing_content(status,scheduled_at);
CREATE TABLE IF NOT EXISTS marketing_spend (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, provider TEXT NOT NULL,
 spend_date TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>=0), currency TEXT NOT NULL DEFAULT 'USD',
 provider_record_id TEXT, import_batch TEXT, created_at TEXT NOT NULL,
 UNIQUE(provider,campaign_id,spend_date,provider_record_id),
 FOREIGN KEY(campaign_id) REFERENCES marketing_campaigns(id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_spend_campaign_date ON marketing_spend(campaign_id,spend_date);
CREATE TABLE IF NOT EXISTS marketing_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER, lead_id INTEGER, event_type TEXT NOT NULL,
 source_module TEXT NOT NULL, source_record_id TEXT, idempotency_key TEXT UNIQUE,
 value_amount REAL, currency TEXT DEFAULT 'USD', payload_json TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL,
 created_at TEXT NOT NULL, FOREIGN KEY(campaign_id) REFERENCES marketing_campaigns(id),
 FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_events_campaign ON marketing_events(campaign_id,event_type,occurred_at);
CREATE TABLE IF NOT EXISTS marketing_connections (
 id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, account_label TEXT,
 account_external_id TEXT, status TEXT NOT NULL DEFAULT 'not_connected', scopes_json TEXT NOT NULL DEFAULT '[]',
 token_ciphertext TEXT, token_expires_at TEXT, last_sync_at TEXT, last_error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider,account_external_id)
);
CREATE TABLE IF NOT EXISTS marketing_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 available_at TEXT NOT NULL, locked_at TEXT, last_error TEXT, idempotency_key TEXT UNIQUE,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_jobs_ready ON marketing_jobs(status,available_at);
CREATE TABLE IF NOT EXISTS marketing_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL,
 entity_id INTEGER, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
