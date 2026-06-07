ALTER TABLE chain_transactions
  ADD COLUMN IF NOT EXISTS paired_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS transaction_type TEXT,
  ADD COLUMN IF NOT EXISTS internal_transfer_status TEXT,
  ADD COLUMN IF NOT EXISTS transfer_primary BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE transaction_annotations
  ADD COLUMN IF NOT EXISTS linked_chain_tx_ids JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE INDEX IF NOT EXISTS idx_chain_internal_transfer
  ON chain_transactions (tenant_id, transaction_type, internal_transfer_status);
