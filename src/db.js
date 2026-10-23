/**
 * db.js — PostgreSQL connection for StockWallet Bot state persistence.
 * Stores bot_state (lastProcessedBlock, pauseUntil, processedEvents) in a single row.
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
 * Create the bot_state table if it doesn't exist.
 * Single-row design — key='singleton'.
 */
export async function initDB(): Promise<void> {
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
    `);
    console.log('[DB] bot_state table ready in PostgreSQL');
  } finally {
    client.release();
  }
}

/**
 * Load the bot state from PostgreSQL.
 * Returns null if not yet initialized.
 */
export async function loadState(): Promise<{
  lastProcessedBlock: string;
  pauseUntil: number;
  processedEvents: string[];
} | null> {
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
export async function saveState(state: {
  lastProcessedBlock: string;
  pauseUntil: number;
  processedEvents: string[];
}): Promise<void> {
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
export async function initState(latestBlock: string): Promise<void> {
  await pool.query(
    `INSERT INTO bot_state (key, last_processed_block, pause_until, processed_events, updated_at)
     VALUES ('singleton', $1, 0, '[]', $2)
     ON CONFLICT (key) DO NOTHING`,
    [latestBlock, Date.now()]
  );
}

/**
 * Close the pool cleanly.
 */
export async function closeDB(): Promise<void> {
  await pool.end();
}

export default pool;