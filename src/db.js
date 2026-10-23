/**
 * db.js — PostgreSQL connection for StockWallet Bot.
 * Stores bot_state + stockwallet_activity (historical log of bot evaluations).
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
    `);
    console.log('[DB] Tables ready: bot_state, stockwallet_activity');
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
 * Log an activity entry — every evaluation, investment, or sale.
 */
export async function logActivity(entry) {
  await pool.query(
    `INSERT INTO stockwallet_activity
      (timestamp, type, asset, asset_symbol, balance, estimated_value, invested, action, reason, tx_hash, pool_fee, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      Date.now(),
      entry.type,              // 'evaluation' | 'investment' | 'sale' | 'deposit' | 'pause'
      entry.asset || null,
      entry.assetSymbol || null,
      entry.balance || null,
      entry.estimatedValue || null,
      entry.invested || null,
      entry.action,            // 'HOLD' | 'SELL_ALL' | 'SELL_PROFIT' | 'INVEST' | 'SKIP' | 'PAUSE'
      entry.reason || null,
      entry.txHash || null,
      entry.poolFee || null,
      entry.confidence || null,
    ]
  );
}

/**
 * Close the pool cleanly.
 */
export async function closeDB() {
  await pool.end();
}

export default pool;