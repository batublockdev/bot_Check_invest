/**
 * nonce-manager.js — Atomic nonce coordination via Redis.
 * Keyed by chainId:signerAddress to avoid collisions.
 *
 * Strategy:
 * 1. On first use, sync from on-chain transactionCount.
 * 2. Use Redis INCR for atomic increment.
 * 3. Periodic resync to correct drift (e.g. after txs from other sources).
 */

import { redis } from './redis.js';

const NONCE_PREFIX = 'nonce';
const RESYNC_INTERVAL_MS = 60_000; // resync every 60s

const resyncTimestamps = new Map();

/**
 * Build Redis key for nonce tracking.
 */
function nonceKey(chainId, signerAddress) {
  return `${NONCE_PREFIX}:${chainId}:${signerAddress.toLowerCase()}`;
}

/**
 * Get the next nonce for a signer on a given chain.
 * Uses Redis INCR for atomic increment.
 * Syncs from on-chain on first use or periodically.
 *
 * @param {object} publicClient - viem public client
 * @param {number} chainId
 * @param {string} signerAddress
 * @returns {Promise<number>}
 */
export async function getNextNonce(publicClient, chainId, signerAddress) {
  const key = nonceKey(chainId, signerAddress);

  // Check if we need to resync from chain
  const lastResync = resyncTimestamps.get(key) || 0;
  const needsResync = Date.now() - lastResync > RESYNC_INTERVAL_MS;

  const exists = await redis.exists(key);

  if (!exists || needsResync) {
    // Sync from on-chain
    const onChainNonce = await publicClient.getTransactionCount({
      address: signerAddress,
    });

    // Set to on-chain value (only if our tracking is behind)
    const currentRedis = exists ? parseInt(await redis.get(key), 10) : 0;

    if (onChainNonce > currentRedis) {
      // On-chain is ahead (e.g. txs sent elsewhere) — resync
      await redis.set(key, onChainNonce);
      console.log(`[nonce] Resynced ${key} to on-chain value: ${onChainNonce}`);
    } else if (!exists) {
      await redis.set(key, onChainNonce);
      console.log(`[nonce] Initialized ${key} from on-chain: ${onChainNonce}`);
    }

    resyncTimestamps.set(key, Date.now());
  }

  // Atomic increment
  const nonce = await redis.incr(key);

  return nonce - 1; // INCR returns value after increment; we want the nonce to use
}

/**
 * Rollback nonce by 1 (e.g. if a tx failed before being sent).
 */
export async function rollbackNonce(chainId, signerAddress) {
  const key = nonceKey(chainId, signerAddress);
  await redis.decr(key);
  console.log(`[nonce] Rolled back ${key}`);
}

/**
 * Force resync on next call.
 */
export function forceResync(chainId, signerAddress) {
  const key = nonceKey(chainId, signerAddress);
  resyncTimestamps.set(key, 0);
}
