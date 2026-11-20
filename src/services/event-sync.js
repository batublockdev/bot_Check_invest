/**
 * event-sync.js — Indexación de eventos on-chain para múltiples contratos.
 * BNB Chain (BSC) — Chain ID 56.
 *
 * Uso: npm run event-sync
 */

import { createPublicClient, http, getAddress } from 'viem';
import { bsc } from 'viem/chains';
import { Queue } from 'bullmq';

import {
  BSC_RPC_URL,
  QUEUE_NAMES,
  CHAIN_ID,
  PAUSE_SECONDS,
} from '../config.js';

import {
  assetDepositedEvent,
  assetSoldEvent,
  assetPurchasedEvent,
  stopLossTriggeredEvent,
  takeProfitTriggeredEvent,
  investmentExecutedEvent,
  gasSwappedEvent,
} from '../lib/abi.js';

import {
  initDB,
  getActiveWallets,
  getRuntimeState,
  updateRuntimeState,
  logActivity,
} from '../lib/db.js';

import { redis } from '../lib/redis.js';

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

const executionQueue = new Queue(QUEUE_NAMES.EXECUTION, {
  connection: redis,
});

// --------------------------------------------------
// Events to fetch
// --------------------------------------------------

const EVENT_DEFS = [
  { event: assetDepositedEvent, kind: 'deposit' },
  { event: assetSoldEvent, kind: 'sale' },
  { event: assetPurchasedEvent, kind: 'purchase' },
  { event: stopLossTriggeredEvent, kind: 'stop_loss' },
  { event: takeProfitTriggeredEvent, kind: 'take_profit' },
  { event: investmentExecutedEvent, kind: 'investment_executed' },
  { event: gasSwappedEvent, kind: 'gas_swap' },
];

// --------------------------------------------------
// Fetch logs for a contract
// --------------------------------------------------

async function fetchContractLogs(contractAddress, fromBlock, toBlock) {
  const allLogs = [];

  const results = await Promise.allSettled(
    EVENT_DEFS.map(({ event, kind }) =>
      publicClient.getLogs({
        address: contractAddress,
        event,
        fromBlock,
        toBlock,
      }).then(logs => logs.map(log => ({ ...log, kind })))
    )
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allLogs.push(...result.value);
    }
  }

  allLogs.sort((a, b) => {
    const blockA = a.blockNumber ?? 0n;
    const blockB = b.blockNumber ?? 0n;
    if (blockA !== blockB) return blockA < blockB ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  return allLogs;
}

// --------------------------------------------------
// Process a single log
// --------------------------------------------------

function eventKey(log) {
  return `${log.transactionHash}-${log.logIndex}`;
}

async function processLog(wallet, log, runtimeState) {
  const { kind, args, blockNumber, transactionHash } = log;
  const key = eventKey(log);

  if (runtimeState.processed_events?.includes(key)) return;

  const block = await publicClient.getBlock({ blockNumber });
  const eventTimestamp = Number(block.timestamp);

  switch (kind) {
    case 'deposit': {
      console.log(`[event-sync] Deposit on wallet ${wallet.id}: token=${args.token?.slice(0,8)}...`);

      await logActivity({
        walletId: wallet.id,
        type: 'deposit',
        asset: args.token,
        action: 'DEPOSIT',
        reason: `Deposit from ${args.user} — ${args.amountDeposited?.toString()} tokens, ${args.usdcReceived?.toString()} received`,
        txHash: transactionHash,
      });

      await executionQueue.add('execute-invest', {
        walletId: wallet.id,
        contractAddress: wallet.contract_address,
        chainId: wallet.chain_id,
        detectedAt: Date.now(),
      }, {
        jobId: `invest-${wallet.id}-${transactionHash}`,
        removeOnComplete: 50,
        removeOnFail: 20,
      });

      break;
    }

    case 'sale':
    case 'stop_loss':
    case 'take_profit': {
      console.log(`[event-sync] ${kind} on wallet ${wallet.id}`);

      const action = kind === 'stop_loss' ? 'SELL_ALL' : kind === 'take_profit' ? 'SELL_PROFIT' : 'SELL';

      await logActivity({
        walletId: wallet.id,
        type: 'sale',
        asset: args.token,
        action,
        balance: args.tokensSold?.toString(),
        estimatedValue: args.usdcReceived?.toString(),
        invested: args.referenceInvested?.toString(),
        reason: `${kind} detected from on-chain event`,
        txHash: transactionHash,
      });

      const newPauseUntil = eventTimestamp + PAUSE_SECONDS;
      const existingPause = Number(runtimeState.pause_until || 0);
      const finalPause = Math.max(existingPause, newPauseUntil);

      await updateRuntimeState(wallet.id, { pause_until: finalPause });
      console.log(`[event-sync] Pause for wallet ${wallet.id} until ${new Date(finalPause * 1000).toISOString()}`);

      break;
    }

    case 'purchase': {
      await logActivity({
        walletId: wallet.id,
        type: 'purchase',
        asset: args.token,
        action: 'PURCHASED',
        balance: args.tokensReceived?.toString(),
        estimatedValue: args.usdcSpent?.toString(),
        reason: `Asset purchased — ${args.usdcSpent?.toString()} → ${args.tokensReceived?.toString()}`,
        txHash: transactionHash,
      });
      break;
    }

    case 'investment_executed': {
      await logActivity({
        walletId: wallet.id,
        type: 'investment',
        action: 'INVEST_EXECUTED',
        estimatedValue: args.totalUsdc?.toString(),
        reason: `Investment executed — total: ${args.totalUsdc?.toString()}, gas: ${args.gasFee?.toString()}, agent: ${args.agentFee?.toString()}`,
        txHash: transactionHash,
      });
      break;
    }

    case 'gas_swap': {
      await logActivity({
        walletId: wallet.id,
        type: 'gas_swap',
        asset: args.tokenIn,
        action: 'GAS_SWAP',
        balance: args.amountIn?.toString(),
        estimatedValue: args.amountOut?.toString(),
        reason: `Gas swap — ${args.amountIn?.toString()} → ${args.amountOut?.toString()}`,
        txHash: transactionHash,
      });
      break;
    }
  }

  return key;
}

// --------------------------------------------------
// Sync events for a single wallet
// --------------------------------------------------

const BLOCK_RANGE = 1000n;

async function syncWalletEvents(wallet) {
  const runtimeState = await getRuntimeState(wallet.id);

  if (!runtimeState) {
    const latestBlock = await publicClient.getBlockNumber();
    await updateRuntimeState(wallet.id, { last_block_processed: latestBlock.toString() });
    console.log(`[event-sync] Initialized wallet ${wallet.id} at block ${latestBlock}`);
    return;
  }

  const latestBlock = await publicClient.getBlockNumber();
  let fromBlock = BigInt(runtimeState.last_block_processed || 0) + 1n;

  if (fromBlock === 1n || (latestBlock - fromBlock) > BLOCK_RANGE * 100n) {
    console.log(`[event-sync] Wallet ${wallet.id}: block too old, resetting to ${latestBlock}`);
    fromBlock = latestBlock;
  }

  if (fromBlock > latestBlock) return;

  const contractAddress = getAddress(wallet.contract_address);
  let processedEvents = Array.isArray(runtimeState.processed_events) ? runtimeState.processed_events : [];

  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + BLOCK_RANGE - 1n < latestBlock
      ? fromBlock + BLOCK_RANGE - 1n
      : latestBlock;

    try {
      const logs = await fetchContractLogs(contractAddress, fromBlock, toBlock);

      for (const log of logs) {
        const key = await processLog(wallet, log, { ...runtimeState, processed_events: processedEvents });
        if (key) {
          processedEvents.push(key);
          if (processedEvents.length > 5000) {
            processedEvents = processedEvents.slice(-3000);
          }
        }
      }

      await updateRuntimeState(wallet.id, {
        last_block_processed: toBlock.toString(),
        processed_events: processedEvents,
      });

    } catch (err) {
      if (/network|timeout|rate|429/i.test(err?.message || '')) {
        console.error(`[event-sync] RPC error for wallet ${wallet.id}:`, err.message);
        break;
      }
      console.error(`[event-sync] Error wallet ${wallet.id} blocks ${fromBlock}-${toBlock}:`, err.message);
    }

    fromBlock = toBlock + 1n;
  }
}

// --------------------------------------------------
// Main sync cycle
// --------------------------------------------------

const SYNC_INTERVAL_MS = Number(process.env.EVENT_SYNC_INTERVAL_MS || '20000');

async function runSyncCycle() {
  let wallets;
  try {
    wallets = await getActiveWallets();
  } catch (err) {
    console.error('[event-sync] Failed to load wallets:', err.message);
    return;
  }

  if (wallets.length === 0) {
    console.warn('[event-sync] No active wallets');
    return;
  }

  console.log(`[event-sync] Syncing ${wallets.length} wallets...`);

  let synced = 0;
  let errors = 0;

  for (const wallet of wallets) {
    if (Number(wallet.chain_id) !== CHAIN_ID) continue;

    try {
      await syncWalletEvents(wallet);
      synced++;
    } catch (err) {
      console.error(`[event-sync] Error syncing wallet ${wallet.id}:`, err.message);
      errors++;
    }
  }

  console.log(`[event-sync] Done: ${synced} synced, ${errors} errors`);
}

// --------------------------------------------------
// Health check
// --------------------------------------------------

import { createServer } from 'http';

const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'event-sync', timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const HEALTH_PORT = Number(process.env.HEALTH_PORT || '3004');

// --------------------------------------------------
// Startup
// --------------------------------------------------

async function main() {
  console.log('[event-sync] Starting...');
  console.log(`[event-sync] RPC: ${BSC_RPC_URL}`);
  console.log(`[event-sync] Chain: BNB Chain (BSC, chainId: ${CHAIN_ID})`);
  console.log(`[event-sync] Sync interval: ${SYNC_INTERVAL_MS}ms`);

  await initDB();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID ${chainId}; expected BSC ${CHAIN_ID}`);
  }
  console.log(`[event-sync] Connected to BNB Chain (chainId: ${chainId})`);

  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[event-sync] Health check on :${HEALTH_PORT}/health`);
  });

  await runSyncCycle();

  const interval = setInterval(() => {
    runSyncCycle().catch((err) => {
      console.error('[event-sync] Cycle error:', err.message);
    });
  }, SYNC_INTERVAL_MS);

  const shutdown = async () => {
    console.log('[event-sync] Shutting down...');
    clearInterval(interval);
    healthServer.close();
    await executionQueue.close();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[event-sync] Fatal:', err);
  process.exit(1);
});
