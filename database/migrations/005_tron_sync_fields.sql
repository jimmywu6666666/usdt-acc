ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS chain_balance NUMERIC(30, 6),
  ADD COLUMN IF NOT EXISTS chain_balance_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT;

ALTER TABLE chain_transactions
  ADD COLUMN IF NOT EXISTS event_index INTEGER;

ALTER TABLE chain_transactions
  DROP CONSTRAINT IF EXISTS chain_transactions_tenant_id_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_wallet_hash_event
  ON chain_transactions (tenant_id, wallet_id, hash, COALESCE(event_index, -1));
