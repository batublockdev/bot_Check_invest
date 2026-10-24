/**
 * db.js — PostgreSQL connection for StockWallet Bot.
 * Stores bot_state, stockwallet_asset_status (latest token snapshot),
 * and stockwallet_activity (filtered historical log of key events).
 */

import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

let initialized = false;
const RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS || '7');

/**
 * Create tables if they don't exist.
 */
export async function initDB() {
  if (initialized) return;
  initialized = true;

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY DEFAULT 'singleton',
        last_processed_block TEXT NOT NULL DEFAULT '0',
        pause_until BIGINT NOT NULL DEFAULT 0,
        processed_events JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at BIGINT NOT NULL DEFAULT 0
      );

      INSERT INTO bot_state (key)
      VALUES ('singleton')
      ON CONFLICT (key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS stockwallet_activity (
        id SERIAL PRIMARY KEY,
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

      CREATE INDEX IF NOT EXISTS stockwallet_activity_ts_idx
        ON stockwallet_activity(timestamp DESC);

      CREATE TABLE IF NOT EXISTS stockwallet_asset_status (
        asset TEXT PRIMARY KEY,
        symbol TEXT,
        balance TEXT,
        estimated_value TEXT,
        invested TEXT,
        pool_fee INTEGER,
        action TEXT,
        reason TEXT,
        updated_at BIGINT NOT NULL
      );
    `);
    console.log('[DB] Tables ready: bot_state, stockwallet_activity, stockwallet_asset_status');
  } finally {
    client.release();
  }
}

/**
 * Load the bot state from PostgreSQL.
 */
export async function loadState() {
  const res = await pool.query(
    `SELECT last_processed_block, pause_until, processed_events
     FROM bot_state WHERE key = 'singleton'`
  );

  if (res.rows.length === 0) return null;

  const row = res.rows[0];
  return {
    lastProcessedBlock: String(row.last_processed_block),
    pauseUntil: Number(row.pause_until ?? 0),
    processedEvents: Array.isArray(row.processed_events) ? row.processed_events : [],
  };
}

/**
 * Save the bot state to PostgreSQL.
 */
export async function saveState(state) {
  await pool.query(
    `UPDATE bot_state
     SET last_processed_block = $1,
         pause_until = $2,
         processed_events = $3,
         updated_at = $4
     WHERE key = 'singleton'`,
    [
      state.lastProcessedBlock,
      state.pauseUntil,
      JSON.stringify(state.processedEvents),
      Date.now(),
    ]
  );
}

/**
 * Initialize the state row with the first block number.
 */
export async function initState(latestBlock) {
  await pool.query(
    `INSERT INTO bot_state (key, last_processed_block, pause_until, processed_events, updated_at)
     VALUES ('singleton', $1, 0, '[]', $2)
     ON CONFLICT (key) DO NOTHING`,
    [latestBlock, Date.now()]
  );
}

/**
 * Update the latest status of an asset (UPSERT — single row per token).
 */
export async function updateAssetStatus(entry) {
  if (!entry?.asset) return;
  try {
    await pool.query(
      `INSERT INTO stockwallet_asset_status
        (asset, symbol, balance, estimated_value, invested, pool_fee, action, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (asset) DO UPDATE
       SET symbol = COALESCE(EXCLUDED.symbol, stockwallet_asset_status.symbol),
           balance = COALESCE(EXCLUDED.balance, stockwallet_asset_status.balance),
           estimated_value = COALESCE(EXCLUDED.estimated_value, stockwallet_asset_status.estimated_value),
           invested = COALESCE(EXCLUDED.invested, stockwallet_asset_status.invested),
           pool_fee = COALESCE(EXCLUDED.pool_fee, stockwallet_asset_status.pool_fee),
           action = COALESCE(EXCLUDED.action, stockwallet_asset_status.action),
           reason = COALESCE(EXCLUDED.reason, stockwallet_asset_status.reason),
           updated_at = EXCLUDED.updated_at`,
      [
        entry.asset,
        entry.symbol || null,
        entry.balance || null,
        entry.estimatedValue || null,
        entry.invested || null,
        entry.poolFee ?? null,
        entry.action || null,
        entry.reason || null,
        Date.now(),
      ]
    );
  } catch (error) {
    console.error(`[DB] Failed to update asset status for ${entry.asset}:`, error.message);
  }
}

/**
 * Log an activity entry — only for significant events (sales, investments, deposits, pauses).
 */
export async function logActivity(entry) {
  try {
    await pool.query(
      `INSERT INTO stockwallet_activity
        (timestamp, type, asset, asset_symbol, balance, estimated_value, invested, action, reason, tx_hash, pool_fee, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        Date.now(),
        entry.type,              // 'investment' | 'sale' | 'deposit' | 'pause'
        entry.asset || null,
        entry.assetSymbol || null,
        entry.balance || null,
        entry.estimatedValue || null,
        entry.invested || null,
        entry.action,            // 'SELL_ALL' | 'SELL_PROFIT' | 'INVEST' | 'SIMULATE_INVEST' | 'PAUSE' | 'SKIP'
        entry.reason || null,
        entry.txHash || null,
        entry.poolFee || null,
        entry.confidence || null,
      ]
    );
  } catch (error) {
    console.error('[DB] Failed to log activity:', error.message);
  }
}

/**
 * Purge activity logs older than retentionDays (default 7 days).
 * Also cleans legacy spam logs (HOLD / SKIP) older than 1 hour.
 */
export async function purgeOldActivity(retentionDays = RETENTION_DAYS) {
  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const legacyCutoff = Date.now() - 60 * 60 * 1000;

    const res1 = await pool.query(
      `DELETE FROM stockwallet_activity WHERE timestamp < $1`,
      [cutoff]
    );

    const res2 = await pool.query(
      `DELETE FROM stockwallet_activity
       WHERE action IN ('HOLD', 'SKIP') AND timestamp < $1`,
      [legacyCutoff]
    );

    const totalPurged = (res1.rowCount || 0) + (res2.rowCount || 0);
    if (totalPurged > 0) {
      console.log(`[DB] Purged ${totalPurged} obsolete activity records.`);
    }
    return totalPurged;
  } catch (error) {
    console.error('[DB] Failed to purge old activity:', error.message);
    return 0;
  }
}

/**
 * Close the pool cleanly.
 */
export async function closeDB() {
  await pool.end();
}

export default pool;