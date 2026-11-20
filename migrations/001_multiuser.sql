-- 001_multiuser.sql — Multiuser schema for StockWallet bot
-- Run with: npm run migrate

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id VARCHAR(50) UNIQUE,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Wallets (1 contract StockWallet per user)
CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  chain_id INT NOT NULL DEFAULT 42220,
  contract_address TEXT NOT NULL UNIQUE,
  status VARCHAR(20) DEFAULT 'active', -- active | paused | disabled
  created_at TIMESTAMP DEFAULT NOW()
);

-- Monitored markets (shared price sources)
CREATE TABLE IF NOT EXISTS monitored_markets (
  id SERIAL PRIMARY KEY,
  chain_id INT NOT NULL DEFAULT 56,
  dex VARCHAR(50) DEFAULT 'uniswap_v3',
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  fee_tier INT,
  pool_address TEXT,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Price snapshots (audit trail)
CREATE TABLE IF NOT EXISTS price_snapshots (
  id SERIAL PRIMARY KEY,
  market_id INT REFERENCES monitored_markets(id) ON DELETE CASCADE,
  price TEXT NOT NULL,
  block_number BIGINT,
  timestamp BIGINT NOT NULL,
  source VARCHAR(50) DEFAULT 'quoter_v3',
  metadata JSONB
);

-- Execution records
CREATE TABLE IF NOT EXISTS execution_records (
  id SERIAL PRIMARY KEY,
  wallet_id INT REFERENCES wallets(id) ON DELETE CASCADE,
  token_address TEXT NOT NULL,
  trigger_type VARCHAR(20), -- stop_loss | take_profit
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | sent | confirmed | failed
  tx_hash TEXT,
  nonce BIGINT,
  error TEXT,
  detected_at TIMESTAMP,
  sent_at TIMESTAMP,
  confirmed_at TIMESTAMP
);

-- Contract runtime state (replaces bot_state singleton)
CREATE TABLE IF NOT EXISTS contract_runtime_state (
  wallet_id INT REFERENCES wallets(id) ON DELETE CASCADE UNIQUE,
  pause_until BIGINT NOT NULL DEFAULT 0,
  last_evaluated_at BIGINT NOT NULL DEFAULT 0,
  last_block_processed BIGINT NOT NULL DEFAULT 0,
  processed_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);

-- Activity log (adapted from original stockwallet_activity — now per wallet)
CREATE TABLE IF NOT EXISTS stockwallet_activity (
  id SERIAL PRIMARY KEY,
  wallet_id INT REFERENCES wallets(id) ON DELETE CASCADE,
  timestamp BIGINT NOT NULL,
  type TEXT NOT NULL,
  asset TEXT,
  asset_symbol TEXT,
  balance TEXT,
  estimated_value TEXT,
  invested TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  tx_hash TEXT,
  pool_fee INTEGER,
  confidence INTEGER
);

CREATE INDEX IF NOT EXISTS activity_wallet_ts_idx
  ON stockwallet_activity(wallet_id, timestamp DESC);

-- Asset status (adapted — now per wallet)
CREATE TABLE IF NOT EXISTS stockwallet_asset_status (
  wallet_id INT REFERENCES wallets(id) ON DELETE CASCADE,
  asset TEXT NOT NULL,
  symbol TEXT,
  balance TEXT,
  estimated_value TEXT,
  invested TEXT,
  pool_fee INTEGER,
  action TEXT,
  reason TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (wallet_id, asset)
);
