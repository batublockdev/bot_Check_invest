/**
 * db.js — PostgreSQL connection layer for multiuser StockWallet.
 * Adapted from original db.js to support multiple wallets/contracts.
 */

import { Pool } from 'pg';
import { DATABASE_URL } from '../config.js';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

let initialized = false;

// --------------------------------------------------
// Schema initialization
// --------------------------------------------------

export async function initDB() {
  if (initialized) return;
  initialized = true;

  const client = await pool.connect();
  try {
    await client.query(`
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
        chain_id INT NOT NULL DEFAULT 56,
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

      -- Activity log (adapted from original stockwallet_activity)
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
    `);
    console.log('[DB] Tables ready (multiuser schema)');
  } finally {
    client.release();
  }
}

// --------------------------------------------------
// Wallets
// --------------------------------------------------

export async function getActiveWallets() {
  const res = await pool.query(
    `SELECT w.id, w.user_id, w.chain_id, w.contract_address, w.status,
            crs.pause_until, crs.last_evaluated_at, crs.last_block_processed
     FROM wallets w
     LEFT JOIN contract_runtime_state crs ON crs.wallet_id = w.id
     WHERE w.status = 'active'
     ORDER BY w.id`
  );
  return res.rows;
}

export async function getWalletById(id) {
  const res = await pool.query(
    `SELECT * FROM wallets WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

export async function registerWallet(userId, contractAddress, chainId = 42220) {
  const res = await pool.query(
    `INSERT INTO wallets (user_id, chain_id, contract_address)
     VALUES ($1, $2, $3)
     ON CONFLICT (contract_address) DO UPDATE
     SET status = 'active', updated_at = NOW()
     RETURNING id`,
    [userId, chainId, contractAddress]
  );
  const walletId = res.rows[0].id;

  // Init runtime state
  await pool.query(
    `INSERT INTO contract_runtime_state (wallet_id)
     VALUES ($1)
     ON CONFLICT (wallet_id) DO NOTHING`,
    [walletId]
  );

  return walletId;
}

// --------------------------------------------------
// Contract runtime state
// --------------------------------------------------

export async function getRuntimeState(walletId) {
  const res = await pool.query(
    `SELECT * FROM contract_runtime_state WHERE wallet_id = $1`,
    [walletId]
  );
  return res.rows[0] || null;
}

export async function updateRuntimeState(walletId, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    if (key === 'processed_events') {
      sets.push(`processed_events = $${idx}`);
      vals.push(JSON.stringify(val));
    } else {
      sets.push(`${key} = $${idx}`);
      vals.push(val);
    }
    idx++;
  }

  sets.push(`updated_at = $${idx}`);
  vals.push(Date.now());
  idx++;

  vals.push(walletId);

  await pool.query(
    `UPDATE contract_runtime_state SET ${sets.join(', ')} WHERE wallet_id = $${idx}`,
    vals
  );
}

export async function isWalletPaused(walletId) {
  const state = await getRuntimeState(walletId);
  if (!state) return false;
  return Math.floor(Date.now() / 1000) < Number(state.pause_until);
}

// --------------------------------------------------
// Monitored markets
// --------------------------------------------------

export async function getActiveMarkets() {
  const res = await pool.query(
    `SELECT * FROM monitored_markets WHERE status = 'active' ORDER BY id`
  );
  return res.rows;
}

export async function addMarket({ chainId = 42220, dex = 'uniswap_v3', tokenIn, tokenOut, feeTier, poolAddress }) {
  const res = await pool.query(
    `INSERT INTO monitored_markets (chain_id, dex, token_in, token_out, fee_tier, pool_address)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [chainId, dex, tokenIn, tokenOut, feeTier, poolAddress]
  );
  return res.rows[0].id;
}

// --------------------------------------------------
// Price snapshots
// --------------------------------------------------

export async function savePriceSnapshot({ marketId, price, blockNumber, source = 'quoter_v3', metadata }) {
  const res = await pool.query(
    `INSERT INTO price_snapshots (market_id, price, block_number, timestamp, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [marketId, String(price), blockNumber?.toString() || null, Date.now(), source, metadata ? JSON.stringify(metadata) : null]
  );
  return res.rows[0].id;
}

// --------------------------------------------------
// Execution records
// --------------------------------------------------

export async function createExecutionRecord({ walletId, tokenAddress, triggerType }) {
  const res = await pool.query(
    `INSERT INTO execution_records (wallet_id, token_address, trigger_type, status, detected_at)
     VALUES ($1, $2, $3, 'pending', NOW())
     RETURNING id`,
    [walletId, tokenAddress, triggerType]
  );
  return res.rows[0].id;
}

export async function updateExecutionRecord(id, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = $${idx}`);
    vals.push(val);
    idx++;
  }

  vals.push(id);

  await pool.query(
    `UPDATE execution_records SET ${sets.join(', ')} WHERE id = $${idx}`,
    vals
  );
}

// --------------------------------------------------
// Activity log (adapted from original)
// --------------------------------------------------

export async function logActivity({ walletId, type, asset, assetSymbol, balance, estimatedValue, invested, action, reason, txHash, poolFee, confidence }) {
  try {
    await pool.query(
      `INSERT INTO stockwallet_activity
        (wallet_id, timestamp, type, asset, asset_symbol, balance, estimated_value, invested, action, reason, tx_hash, pool_fee, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        walletId,
        Date.now(),
        type,
        asset || null,
        assetSymbol || null,
        balance || null,
        estimatedValue || null,
        invested || null,
        action,
        reason || null,
        txHash || null,
        poolFee ?? null,
        confidence ?? null,
      ]
    );
  } catch (error) {
    console.error('[DB] Failed to log activity:', error.message);
  }
}

// --------------------------------------------------
// Asset status (adapted — now per wallet)
// --------------------------------------------------

export async function updateAssetStatus({ walletId, asset, symbol, balance, estimatedValue, invested, poolFee, action, reason }) {
  if (!asset || !walletId) return;
  try {
    await pool.query(
      `INSERT INTO stockwallet_asset_status
        (wallet_id, asset, symbol, balance, estimated_value, invested, pool_fee, action, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (wallet_id, asset) DO UPDATE
       SET symbol = COALESCE(EXCLUDED.symbol, stockwallet_asset_status.symbol),
           balance = COALESCE(EXCLUDED.balance, stockwallet_asset_status.balance),
           estimated_value = COALESCE(EXCLUDED.estimated_value, stockwallet_asset_status.estimated_value),
           invested = COALESCE(EXCLUDED.invested, stockwallet_asset_status.invested),
           pool_fee = COALESCE(EXCLUDED.pool_fee, stockwallet_asset_status.pool_fee),
           action = COALESCE(EXCLUDED.action, stockwallet_asset_status.action),
           reason = COALESCE(EXCLUDED.reason, stockwallet_asset_status.reason),
           updated_at = EXCLUDED.updated_at`,
      [
        walletId,
        asset,
        symbol || null,
        balance || null,
        estimatedValue || null,
        invested || null,
        poolFee ?? null,
        action || null,
        reason || null,
        Date.now(),
      ]
    );
  } catch (error) {
    console.error(`[DB] Failed to update asset status for ${asset}:`, error.message);
  }
}

// --------------------------------------------------
// Purge old HOLD logs (adapted)
// --------------------------------------------------

export async function purgeOldActivity() {
  try {
    const holdCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const res = await pool.query(
      `DELETE FROM stockwallet_activity
       WHERE action = 'HOLD' AND timestamp < $1`,
      [holdCutoff]
    );
    const totalPurged = res.rowCount || 0;
    if (totalPurged > 0) {
      console.log(`[DB] Purged ${totalPurged} HOLD records older than 3 days.`);
    }
    return totalPurged;
  } catch (error) {
    console.error('[DB] Failed to purge old activity:', error.message);
    return 0;
  }
}

// --------------------------------------------------
// Close pool
// --------------------------------------------------

export async function closeDB() {
  await pool.end();
}

export default pool;
