ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS managed_from TIMESTAMPTZ;

UPDATE wallets
SET managed_from = COALESCE(created_at, DATE_TRUNC('day', NOW()))
WHERE managed_from IS NULL;

ALTER TABLE wallets
  ALTER COLUMN managed_from SET NOT NULL;
