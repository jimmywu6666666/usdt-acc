CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TYPE category_type AS ENUM ('income', 'expense');

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  type category_type NOT NULL,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (type, name)
);

CREATE TYPE user_role AS ENUM ('admin', 'supervisor', 'employee');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  name TEXT NOT NULL,
  role user_role NOT NULL,
  can_view_all BOOLEAN NOT NULL DEFAULT TRUE,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TYPE wallet_chain AS ENUM ('TRC20');

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  alias TEXT NOT NULL,
  chain wallet_chain NOT NULL DEFAULT 'TRC20',
  address TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  managed_from TIMESTAMPTZ NOT NULL DEFAULT DATE_TRUNC('day', NOW()),
  chain_balance NUMERIC(30, 6),
  chain_balance_updated_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_sync_attempt_at TIMESTAMPTZ,
  last_sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,
  disabled_by TEXT REFERENCES users(id),
  UNIQUE (tenant_id, address)
);

CREATE TYPE entry_type AS ENUM ('income', 'expense', 'transfer');
CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected', 'corrected');
CREATE TYPE reconcile_status AS ENUM ('unchecked', 'matched', 'suspected', 'missing_chain', 'missing_system');

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type entry_type NOT NULL,
  amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  to_wallet_id TEXT REFERENCES wallets(id),
  category TEXT NOT NULL,
  submitted_by TEXT NOT NULL REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  note TEXT,
  status review_status NOT NULL DEFAULT 'pending',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  correction_of TEXT REFERENCES ledger_entries(id),
  corrected_at TIMESTAMPTZ,
  corrected_by TEXT REFERENCES users(id),
  reconcile_status reconcile_status NOT NULL DEFAULT 'unchecked',
  reconcile_reason TEXT,
  manual_reconcile BOOLEAN NOT NULL DEFAULT FALSE,
  chain_tx_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT REFERENCES users(id),
  CHECK (
    (type = 'transfer' AND to_wallet_id IS NOT NULL AND to_wallet_id <> wallet_id)
    OR
    (type <> 'transfer' AND to_wallet_id IS NULL)
  )
);

CREATE TABLE entry_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chain_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  hash TEXT NOT NULL,
  event_index INTEGER,
  direction entry_type NOT NULL CHECK (direction IN ('income', 'expense')),
  amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  counterparty TEXT,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  chain_time TIMESTAMPTZ NOT NULL,
  matched_entry_id TEXT REFERENCES ledger_entries(id),
  paired_tx_id TEXT,
  transaction_type TEXT,
  internal_transfer_status TEXT,
  transfer_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT REFERENCES users(id)
);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_chain_tx_fk
  FOREIGN KEY (chain_tx_id) REFERENCES chain_transactions(id);

CREATE TABLE wallet_sync_cursors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  chain wallet_chain NOT NULL DEFAULT 'TRC20',
  last_chain_time TIMESTAMPTZ,
  last_tx_hash TEXT,
  last_synced_at TIMESTAMPTZ,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  error_message TEXT,
  UNIQUE (wallet_id, chain)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_categories_type_enabled ON categories (type, enabled, sort_order);
CREATE INDEX idx_users_tenant_role ON users (tenant_id, role);
CREATE INDEX idx_sessions_user_active ON user_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_wallets_tenant_enabled ON wallets (tenant_id, enabled);
CREATE INDEX idx_entries_tenant_filters ON ledger_entries (tenant_id, occurred_at, type, status, reconcile_status)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_wallet ON ledger_entries (wallet_id, occurred_at);
CREATE INDEX idx_attachments_entry ON entry_attachments (entry_id);
CREATE INDEX idx_chain_wallet_time ON chain_transactions (wallet_id, chain_time)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_chain_wallet_hash_event
  ON chain_transactions (tenant_id, wallet_id, hash, COALESCE(event_index, -1));
CREATE INDEX idx_chain_unmatched ON chain_transactions (tenant_id, chain_time)
  WHERE matched_entry_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_chain_internal_transfer
  ON chain_transactions (tenant_id, transaction_type, internal_transfer_status);
CREATE INDEX idx_audit_tenant_time ON audit_logs (tenant_id, created_at DESC);
