DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'annotation_status') THEN
    CREATE TYPE annotation_status AS ENUM ('pending', 'approved', 'rejected', 'corrected', 'reversed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'annotation_correction_type') THEN
    CREATE TYPE annotation_correction_type AS ENUM ('correction', 'reversal');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS transaction_annotations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  chain_tx_id TEXT NOT NULL REFERENCES chain_transactions(id),
  category TEXT NOT NULL,
  note TEXT NOT NULL,
  annotated_by TEXT NOT NULL REFERENCES users(id),
  annotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status annotation_status NOT NULL DEFAULT 'pending',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  previous_annotation_id TEXT REFERENCES transaction_annotations(id),
  superseded_by TEXT REFERENCES transaction_annotations(id),
  version INTEGER NOT NULL CHECK (version > 0),
  correction_type annotation_correction_type,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_tx_id, version)
);

CREATE TABLE IF NOT EXISTS annotation_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  annotation_id TEXT NOT NULL REFERENCES transaction_annotations(id),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chain_transactions
  ADD COLUMN IF NOT EXISTS current_annotation_id TEXT REFERENCES transaction_annotations(id);

CREATE INDEX IF NOT EXISTS idx_annotations_tenant_status
  ON transaction_annotations (tenant_id, status, annotated_at DESC);

CREATE INDEX IF NOT EXISTS idx_annotations_chain_version
  ON transaction_annotations (chain_tx_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_annotation_attachments_annotation
  ON annotation_attachments (annotation_id);
