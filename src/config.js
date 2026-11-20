/**
 * config.js — Centralized environment configuration.
 * BNB Chain (BSC) only. Chain ID 56.
 */

import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
};

const optional = (key, fallback) => process.env[key] ?? fallback;

// --------------------------------------------------
// Core
// --------------------------------------------------
export const DRY_RUN = optional('DRY_RUN', 'true').toLowerCase() === 'true';
export const LOG_LEVEL = optional('LOG_LEVEL', 'info');

// --------------------------------------------------
// Blockchain — BNB Chain (BSC Mainnet, Chain ID 56)
// --------------------------------------------------
export const BSC_RPC_URL = optional('BSC_RPC_URL', 'https://bsc-dataseed.binance.org');
export const CHAIN_ID = 56;
export const UNISWAP_QUOTER_ADDRESS = required('UNISWAP_QUOTER_ADDRESS');
export const BOT_PRIVATE_KEY = required('BOT_PRIVATE_KEY');
export const TAG_ATTRIBUTION = optional('TAG_ATTRIBUTION', '');

// --------------------------------------------------
// Database
// --------------------------------------------------
export const DATABASE_URL = required('DATABASE_URL');

// --------------------------------------------------
// Redis
// --------------------------------------------------
export const REDIS_URL = required('REDIS_URL');

// --------------------------------------------------
// Price Engine
// --------------------------------------------------
export const PRICE_POLL_INTERVAL_MS = Number(optional('PRICE_POLL_INTERVAL_MS', '30000'));

// --------------------------------------------------
// Evaluator
// --------------------------------------------------
export const EVALUATOR_CONCURRENCY = Number(optional('EVALUATOR_CONCURRENCY', '5'));
export const MAX_ASSETS_PER_WALLET = 100;

// --------------------------------------------------
// Executor
// --------------------------------------------------
export const EXECUTOR_CONCURRENCY = Number(optional('EXECUTOR_CONCURRENCY', '2'));
export const TX_TIMEOUT_MS = Number(optional('TX_TIMEOUT_MS', '120000'));
export const PAUSE_SECONDS = 24 * 60 * 60; // 24h pause after sale

// --------------------------------------------------
// Queues (BullMQ names)
// --------------------------------------------------
export const QUEUE_NAMES = {
  EVALUATION: 'evaluation-queue',
  EXECUTION: 'execution-queue',
};

// --------------------------------------------------
// Constants
// --------------------------------------------------
export const BPS = 10_000n;
export const FEE_TIERS_V3 = [100, 500, 3000, 10000];
export const DEDUP_TTL_SECONDS = 300; // 5 min
export const LOCK_TTL_SECONDS = 120;  // 2 min
export const SNAPSHOT_TTL_SECONDS = 30; // 30s cache in Redis

// Validation
if (!/^0x[0-9a-fA-F]{64}$/.test(BOT_PRIVATE_KEY)) {
  throw new Error('BOT_PRIVATE_KEY missing or invalid (must be 0x + 64 hex chars).');
}

if (PRICE_POLL_INTERVAL_MS < 5000) {
  console.warn('[config] PRICE_POLL_INTERVAL_MS < 5000 may cause RPC rate limits.');
}
