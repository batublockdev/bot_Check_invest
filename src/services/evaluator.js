/**
 * evaluator.js — Servicio que evalúa posiciones de múltiples wallets.
 * BNB Chain (BSC) — Chain ID 56.
 *
 * Uso: npm run evaluator
 */

import { createPublicClient, http, getAddress, formatUnits } from 'viem';
import { bsc } from 'viem/chains';
import { Worker, Queue } from 'bullmq';

import {
  BSC_RPC_URL,
  UNISWAP_QUOTER_ADDRESS,
  EVALUATOR_CONCURRENCY,
  MAX_ASSETS_PER_WALLET,
  BPS,
  QUEUE_NAMES,
  CHAIN_ID,
  DEDUP_TTL_SECONDS,
  DRY_RUN,
} from '../config.js';

import {
  stockWalletAbi,
  erc20Abi,
  quoterV2Abi,
} from '../lib/abi.js';

import {
  initDB,
  getActiveWallets,
  getRuntimeState,
  updateRuntimeState,
  updateAssetStatus,
  logActivity,
} from '../lib/db.js';

import { redis, getSnapshot, setDedup, clearDedup } from '../lib/redis.js';

// --------------------------------------------------
// Public client — BSC
// --------------------------------------------------

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC_URL),
});

// --------------------------------------------------
// Execution queue
// --------------------------------------------------

// Dedicated connection for the producer Queue — never share the Worker's
// ioredis connection with a Queue (causes silent add() hangs).
const queueConnection = redis.duplicate();
queueConnection.on('error', (err) => {
  console.error('[evaluator] Queue connection error:', err.message);
});

const executionQueue = new Queue(QUEUE_NAMES.EXECUTION, {
  connection: queueConnection,
});

executionQueue.on('error', (err) => {
  console.error('[evaluator] Execution queue error:', err.message);
});

// --------------------------------------------------
// Contract read helper
// --------------------------------------------------

async function readContract(contractAddress, functionName, args = []) {
  return publicClient.readContract({
    address: contractAddress,
    abi: stockWalletAbi,
    functionName,
    args,
  });
}

// --------------------------------------------------
// Get registered assets for a specific contract
// --------------------------------------------------

async function getRegisteredAssets(contractAddress) {
  const assets = [];

  for (let i = 0; i < MAX_ASSETS_PER_WALLET; i++) {
    try {
      const token = await readContract(contractAddress, 'assets', [BigInt(i)]);

      if (
        token &&
        token.toLowerCase() !== '0x0000000000000000000000000000000000000000'
      ) {
        assets.push(getAddress(token));
      }
    } catch (error) {
      const message = String(error?.shortMessage ?? error?.message ?? '');

      if (/network|timeout|rate|429|server error/i.test(message)) {
        throw error;
      }
      break;
    }
  }

  return [...new Set(assets)];
}

// --------------------------------------------------
// Evaluate a single token position
// --------------------------------------------------

async function evaluateTokenPosition(wallet, token, priceSnapshot) {
  const contractAddress = wallet.contract_address;

  const [balance, position, config, symbol, decimals] = await Promise.all([
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [contractAddress],
    }),
    readContract(contractAddress, 'assetPosition', [token]),
    readContract(contractAddress, 'assetConfig', [token]),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'symbol',
    }).catch(() => 'UNKNOWN'),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
  ]);

  const invested = BigInt(position[1]);
  const stopLossBps = BigInt(config[1]);
  const takeProfitBps = BigInt(config[2]);

  if (balance === 0n || invested === 0n) {
    return { action: 'SKIP', reason: 'No balance or no investment' };
  }

  // Calculate current value from snapshot
  const refAmount = 10n ** 18n;
  const pricePerUnit = BigInt(priceSnapshot.pricePerUnit);
  const currentValue = (balance * pricePerUnit) / refAmount;

  // Check triggers
  const belowStop =
    stopLossBps > 0n &&
    currentValue * BPS <= invested * stopLossBps;

  const aboveTake =
    takeProfitBps > 0n &&
    currentValue * BPS >= invested * takeProfitBps;

  let action = 'HOLD';
  let triggerType = null;
  let reason = 'Within thresholds';

  if (belowStop) {
    action = 'SELL_ALL';
    triggerType = 'stop_loss';
    reason = 'Stop loss triggered';
  } else if (aboveTake) {
    action = 'SELL_PROFIT';
    triggerType = 'take_profit';
    reason = 'Take profit triggered';
  }

  await updateAssetStatus({
    walletId: wallet.id,
    asset: token,
    symbol,
    balance: formatUnits(balance, decimals),
    estimatedValue: formatUnits(currentValue, 18),
    invested: formatUnits(invested, 18),
    poolFee: priceSnapshot.fee,
    action: action === 'HOLD' ? 'HOLD' : action,
    reason,
  });

  if (action === 'HOLD') {
    return { action: 'HOLD', reason };
  }

  // Trigger detected — enqueue with dedup
  const dedupKey = `sell:${CHAIN_ID}:${contractAddress.toLowerCase()}:${token.toLowerCase()}`;
  const isUnique = await setDedup(dedupKey, DEDUP_TTL_SECONDS);

  if (!isUnique) {
    console.log(`[evaluator] Dedup hit — skipping ${token.slice(0, 8)}... on ${contractAddress.slice(0, 8)}...`);
    return { action: 'DEDUPED', reason: 'Duplicate trigger' };
  }

  // Read V4 sell pools and asset path for executor
  let v4SellPools = [];
  try {
    v4SellPools = await readContract(contractAddress, 'getV4SellPools', [token]);
  } catch {
    // V4 may not be configured
  }

  let assetPath = '0x';
  try {
    assetPath = await readContract(contractAddress, 'assetPath', [token]);
  } catch {
    // default empty path
  }

  try {
    await executionQueue.add('execute-sale', {
      walletId: wallet.id,
      contractAddress,
      chainId: CHAIN_ID,
      tokenAddress: token,
      triggerType,
      assetPath,
      v4SellPools: v4SellPools || [],
      priceSnapshotId: priceSnapshot.timestamp,
      detectedAt: Date.now(),
    }, {
      // jobId must be unique per attempt — a static jobId (the dedup key) gets
      // silently dropped by BullMQ when a previous job with the same id still
      // exists in the retained completed/failed sets. Redis dedup key already
      // protects against duplicate triggers within the TTL window.
      jobId: `${dedupKey}:${Date.now()}`,
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  } catch (addError) {
    // Release dedup so the next cycle retries the enqueue cleanly
    await clearDedup(dedupKey);
    console.error(`[evaluator] ❌ Failed to enqueue execute-sale for ${token.slice(0, 8)}...:`, addError.message);
    throw addError;
  }

  await logActivity({
    walletId: wallet.id,
    type: 'sale',
    asset: token,
    assetSymbol: symbol,
    balance: formatUnits(balance, decimals),
    estimatedValue: formatUnits(currentValue, 18),
    invested: formatUnits(invested, 18),
    action: DRY_RUN ? 'SIMULATE_SELL' : action,
    reason: `${reason} | currentValue: ${formatUnits(currentValue, 18)} | invested: ${formatUnits(invested, 18)} | SL: ${stopLossBps}bps | TP: ${takeProfitBps}bps`,
  });

  console.log(`[evaluator] ⚠ Trigger: ${triggerType} for ${symbol} (${token.slice(0, 8)}...) on wallet ${wallet.id}`);

  return { action, triggerType, reason };
}

// --------------------------------------------------
// Process a market evaluation job
// --------------------------------------------------

async function processEvaluationJob(job) {
  const { marketId, tokenIn, tokenOut, pricePerUnit, fee, source, blockNumber, timestamp } = job.data;

  console.log(`[evaluator] Market ${marketId}: ${tokenIn.slice(0, 8)}... -> ${tokenOut.slice(0, 8)}...`);

  const priceSnapshot = {
    tokenIn, tokenOut, pricePerUnit, fee, source, blockNumber, timestamp,
  };

  const wallets = await getActiveWallets();

  if (wallets.length === 0) {
    console.warn('[evaluator] No active wallets');
    return;
  }

  console.log(`[evaluator] Evaluating ${wallets.length} wallets`);

  let triggers = 0;
  let errors = 0;

  for (const wallet of wallets) {
    // Skip if wrong chain
    if (Number(wallet.chain_id) !== CHAIN_ID) continue;

    // NOTE: runtimeState.pause_until only gates RE-INVEST (handled by executor
    // + event-sync). SL/TP evaluation and sale detection must ALWAYS run — a
    // paused wallet must keep being monitored.

    // Check contract pause/tradingPause
    try {
      const [paused, tradingPaused] = await Promise.all([
        readContract(wallet.contract_address, 'paused'),
        readContract(wallet.contract_address, 'tradingPaused'),
      ]);
      if (paused || tradingPaused) continue;
    } catch {
      console.warn(`[evaluator] Can't read pause state for wallet ${wallet.id}`);
      errors++;
      continue;
    }

    // Get assets
    let assets;
    try {
      assets = await getRegisteredAssets(wallet.contract_address);
    } catch (err) {
      console.error(`[evaluator] Failed to get assets for wallet ${wallet.id}:`, err.message);
      errors++;
      continue;
    }

    // Filter assets matching this market's tokenIn
    const relevantAssets = assets.filter(
      (a) => a.toLowerCase() === tokenIn.toLowerCase()
    );

    if (relevantAssets.length === 0) continue;

    for (const token of relevantAssets) {
      try {
        const result = await evaluateTokenPosition(wallet, token, priceSnapshot);
        if (result.action === 'SELL_ALL' || result.action === 'SELL_PROFIT') {
          triggers++;
        }
        await updateRuntimeState(wallet.id, {
          last_evaluated_at: Date.now(),
        });
      } catch (err) {
        console.error(`[evaluator] Error evaluating ${token.slice(0, 8)}... on wallet ${wallet.id}:`, err.message);
        errors++;
      }
    }
  }

  console.log(`[evaluator] Market ${marketId} done: ${triggers} triggers, ${errors} errors`);
}

// --------------------------------------------------
// Health check
// --------------------------------------------------

import { createServer } from 'http';

const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'evaluator', timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const HEALTH_PORT = Number(process.env.HEALTH_PORT || '3002');

// --------------------------------------------------
// Startup
// --------------------------------------------------

async function main() {
  console.log('[evaluator] Starting...');
  console.log(`[evaluator] RPC: ${BSC_RPC_URL}`);
  console.log(`[evaluator] Chain: BNB Chain (BSC, chainId: ${CHAIN_ID})`);
  console.log(`[evaluator] Concurrency: ${EVALUATOR_CONCURRENCY}`);
  console.log(`[evaluator] DRY_RUN: ${DRY_RUN}`);

  await initDB();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID ${chainId}; expected BSC ${CHAIN_ID}`);
  }
  console.log(`[evaluator] Connected to BNB Chain (chainId: ${chainId})`);

  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[evaluator] Health check on :${HEALTH_PORT}/health`);
  });

  const worker = new Worker(
    QUEUE_NAMES.EVALUATION,
    async (job) => {
      console.log(`[evaluator] Job ${job.id}: ${job.name}`);
      await processEvaluationJob(job);
    },
    {
      connection: redis,
      concurrency: EVALUATOR_CONCURRENCY,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[evaluator] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[evaluator] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[evaluator] Worker error:', err.message);
  });

  console.log('[evaluator] Worker started, waiting for jobs...');

  const shutdown = async () => {
    console.log('[evaluator] Shutting down...');
    await worker.close();
    await executionQueue.close();
    await queueConnection.quit();
    healthServer.close();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[evaluator] Fatal:', err);
  process.exit(1);
});
