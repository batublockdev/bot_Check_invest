/**
 * redis.js — Redis connection shared by all services.
 * Used by BullMQ for queues and for locks/snapshots.
 */

import IORedis from 'ioredis';
import { REDIS_URL } from '../config.js';

// Single shared connection for BullMQ + general use
export const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ requirement
  enableReadyCheck: true,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
});

redis.on('connect', () => {
  console.log('[Redis] Connected');
});

redis.on('error', (err) => {
  console.error('[Redis] Error:', err.message);
});

// --------------------------------------------------
// Lock helpers (for executor position locks)
// --------------------------------------------------

export async function acquireLock(key, ttlSeconds) {
  const result = await redis.set(key, '1', 'NX', 'EX', ttlSeconds);
  return result === 'OK';
}

export async function releaseLock(key) {
  await redis.del(key);
}

// --------------------------------------------------
// Dedup helpers (for evaluator — prevent duplicate execution jobs)
// --------------------------------------------------

export async function setDedup(key, ttlSeconds) {
  const result = await redis.set(key, '1', 'NX', 'EX', ttlSeconds);
  return result === 'OK';
}

export async function clearDedup(key) {
  await redis.del(key);
}

// --------------------------------------------------
// Price snapshot cache
// --------------------------------------------------

export async function cacheSnapshot(marketKey, data, ttlSeconds) {
  await redis.set(
    `snapshot:${marketKey}`,
    JSON.stringify(data),
    'EX',
    ttlSeconds
  );
}

export async function getSnapshot(marketKey) {
  const raw = await redis.get(`snapshot:${marketKey}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default redis;
