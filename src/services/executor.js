/**
 * executor.js — Servicio que ejecuta ventas e inversiones on-chain.
 * BNB Chain (BSC) — Chain ID 56.
 *
 * Uso: npm run executor
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { Worker } from 'bullmq';

import {
  BSC_RPC_URL,
  UNISWAP_QUOTER_ADDRESS,
  BOT_PRIVATE_KEY,
  TAG_ATTRIBUTION,
  EXECUTOR_CONCURRENCY,
  TX_TIMEOUT_MS,
  PAUSE_SECONDS,
  BPS,
  FEE_TIERS_V3,
  QUEUE_NAMES,
  CHAIN_ID,
  LOCK_TTL_SECONDS,
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
  getRuntimeState,
  updateRuntimeState,
  createExecutionRecord,
  updateExecutionRecord,
  logActivity,
  updateAssetStatus,
} from '../lib/db.js';

import { redis, acquireLock, releaseLock, clearDedup } from '../lib/redis.js';
import { getNextNonce, rollbackNonce, forceResync } from '../lib/nonce-manager.js';

// --------------------------------------------------
// Clients — BSC
// --------------------------------------------------

const account = privateKeyToAccount(BOT_PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC_URL),
});

// No attribution tags on BSC (Celo-specific)
const walletClient = createWalletClient({
  account,
  chain: bsc,
  transport: http(BSC_RPC_URL),
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
// V3 quoting (for revalidation)
// --------------------------------------------------

async function quoteBestV3(tokenIn, tokenOut, amountIn) {
  let best = null;

  for (const fee of FEE_TIERS_V3) {
    try {
      const result = await publicClient.readContract({
        address: UNISWAP_QUOTER_ADDRESS,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn: getAddress(tokenIn),
          tokenOut: getAddress(tokenOut),
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        }],
      });

      const amountOut = result[0];
      if (amountOut == null) continue;

      if (!best || amountOut > best.amountOut) {
        best = { fee, amountOut };
      }
    } catch {
      // Pool may not exist
    }
  }

  return best;
}

// --------------------------------------------------
// Check ADGENT_ROLE
// --------------------------------------------------

async function checkAgentRole(contractAddress) {
  const role = await readContract(contractAddress, 'ADGENT_ROLE');
  const authorized = await readContract(contractAddress, 'hasRole', [role, account.address]);

  if (!authorized) {
    throw new Error(
      `Account ${account.address} does not have ADGENT_ROLE on ${contractAddress}`
    );
  }

  return true;
}

// --------------------------------------------------
// Execute a sell job
// --------------------------------------------------

async function processSellJob(job) {
  const {
    walletId, contractAddress, chainId,
    tokenAddress, triggerType,
    assetPath, v4SellPools, detectedAt,
  } = job.data;

  const contract = getAddress(contractAddress);
  const token = getAddress(tokenAddress);
  const lockKey = `lock:${chainId}:${contract.toLowerCase()}:${token.toLowerCase()}`;

  console.log(`[executor] Sell: ${triggerType} for ${token.slice(0, 8)}... on ${contract.slice(0, 8)}...`);

  const locked = await acquireLock(lockKey, LOCK_TTL_SECONDS);
  if (!locked) {
    console.log(`[executor] Lock held — skipping`);
    return { status: 'skipped', reason: 'lock_held' };
  }

  const execRecordId = await createExecutionRecord({
    walletId, tokenAddress: token, triggerType,
  });

  try {
    // Check pause states
    const [paused, tradingPaused] = await Promise.all([
      readContract(contract, 'paused'),
      readContract(contract, 'tradingPaused'),
    ]);

    if (paused || tradingPaused) {
      console.log(`[executor] Contract paused — skipping`);
      await updateExecutionRecord(execRecordId, { status: 'failed', error: 'Contract paused' });
      return { status: 'skipped', reason: 'contract_paused' };
    }

    // Check wallet pause
    const runtimeState = await getRuntimeState(walletId);
    if (runtimeState && Math.floor(Date.now() / 1000) < Number(runtimeState.pause_until)) {
      console.log(`[executor] Wallet paused — skipping`);
      await updateExecutionRecord(execRecordId, { status: 'failed', error: 'Wallet paused' });
      return { status: 'skipped', reason: 'wallet_paused' };
    }

    // Revalidate position
    const [balance, position, config, symbol, decimals] = await Promise.all([
      publicClient.readContract({
        address: token, abi: erc20Abi, functionName: 'balanceOf', args: [contract],
      }),
      readContract(contract, 'assetPosition', [token]),
      readContract(contract, 'assetConfig', [token]),
      publicClient.readContract({
        address: token, abi: erc20Abi, functionName: 'symbol',
      }).catch(() => 'UNKNOWN'),
      publicClient.readContract({
        address: token, abi: erc20Abi, functionName: 'decimals',
      }),
    ]);

    const invested = BigInt(position[1]);
    const stopLossBps = BigInt(config[1]);
    const takeProfitBps = BigInt(config[2]);

    if (balance === 0n || invested === 0n) {
      await updateExecutionRecord(execRecordId, { status: 'failed', error: 'No balance or investment' });
      return { status: 'skipped', reason: 'no_balance' };
    }

    // Fresh price quote
    const baseToken = getAddress(await readContract(contract, 'usdc'));
    const freshQuote = await quoteBestV3(token, baseToken, balance);

    if (!freshQuote) {
      await updateExecutionRecord(execRecordId, { status: 'failed', error: 'No quote available' });
      return { status: 'failed', reason: 'no_quote' };
    }

    const currentValue = freshQuote.amountOut;

    // Re-check triggers
    const belowStop = stopLossBps > 0n && currentValue * BPS <= invested * stopLossBps;
    const aboveTake = takeProfitBps > 0n && currentValue * BPS >= invested * takeProfitBps;

    if (triggerType === 'stop_loss' && !belowStop) {
      console.log(`[executor] Stop loss no longer valid — price recovered`);
      await updateExecutionRecord(execRecordId, { status: 'failed', error: 'Trigger expired' });
      await logActivity({
        walletId, type: 'sale', asset: token, assetSymbol: symbol,
        action: 'CANCELLED', reason: `SL revalidation failed — price recovered`,
      });
      return { status: 'cancelled', reason: 'trigger_expired' };
    }

    if (triggerType === 'take_profit' && !aboveTake) {
      console.log(`[executor] Take profit no longer valid — price dropped`);
      await updateExecutionRecord(execRecordId, { status: 'failed', error: 'Trigger expired' });
      await logActivity({
        walletId, type: 'sale', asset: token, assetSymbol: symbol,
        action: 'CANCELLED', reason: `TP revalidation failed — price dropped`,
      });
      return { status: 'cancelled', reason: 'trigger_expired' };
    }

    console.log(`[executor] Revalidation passed: ${triggerType} for ${symbol}`);
    console.log(`  Balance: ${formatUnits(balance, decimals)} ${symbol}`);
    console.log(`  Current value: ${formatUnits(currentValue, 18)}`);
    console.log(`  Invested: ${formatUnits(invested, 18)}`);

    // Check ADGENT_ROLE
    await checkAgentRole(contract);

    // DRY_RUN
    if (DRY_RUN) {
      console.log(`[executor] [DRY RUN] Would send selltoken(${token}, path, v4Pools)`);
      await updateExecutionRecord(execRecordId, { status: 'confirmed', error: 'DRY_RUN' });
      await logActivity({
        walletId, type: 'sale', asset: token, assetSymbol: symbol,
        balance: formatUnits(balance, decimals),
        estimatedValue: formatUnits(currentValue, 18),
        invested: formatUnits(invested, 18),
        action: triggerType === 'stop_loss' ? 'SIMULATE_SELL_ALL' : 'SIMULATE_SELL_PROFIT',
        reason: `DRY_RUN — ${triggerType} confirmed but not executed`,
        poolFee: freshQuote.fee,
      });
      return { status: 'simulated', reason: 'dry_run' };
    }

    // Get nonce
    const nonce = await getNextNonce(publicClient, chainId, account.address);
    console.log(`[executor] Using nonce: ${nonce}`);

    const sellPath = assetPath && assetPath !== '0x' ? assetPath : '0x';

    // Simulate
    let request;
    try {
      const simResult = await publicClient.simulateContract({
        address: contract,
        abi: stockWalletAbi,
        functionName: 'selltoken',
        args: [token, sellPath, v4SellPools || []],
        account,
      });
      request = simResult.request;
    } catch (simError) {
      console.error(`[executor] Simulation failed:`, simError.shortMessage ?? simError.message);
      await rollbackNonce(chainId, account.address);
      await updateExecutionRecord(execRecordId, {
        status: 'failed',
        error: `Simulation failed: ${simError.shortMessage ?? simError.message}`,
      });
      await logActivity({
        walletId, type: 'sale', asset: token, assetSymbol: symbol,
        action: 'FAILED', reason: `Simulation reverted: ${simError.shortMessage ?? simError.message}`,
      });
      return { status: 'failed', reason: 'simulation_reverted' };
    }

    // Send
    let txHash;
    try {
      txHash = await walletClient.writeContract({ ...request, nonce });
    } catch (sendError) {
      console.error(`[executor] Send failed:`, sendError.shortMessage ?? sendError.message);
      await rollbackNonce(chainId, account.address);
      await updateExecutionRecord(execRecordId, {
        status: 'failed',
        error: `Send failed: ${sendError.shortMessage ?? sendError.message}`,
      });
      await logActivity({
        walletId, type: 'sale', asset: token, assetSymbol: symbol,
        action: 'FAILED', reason: `TX send failed: ${sendError.shortMessage ?? sendError.message}`,
      });
      return { status: 'failed', reason: 'send_failed' };
    }

    console.log(`[executor] TX sent: ${txHash}`);

    await updateExecutionRecord(execRecordId, {
      status: 'sent', tx_hash: txHash, nonce,
      sent_at: new Date().toISOString(),
    });

    // Wait for receipt
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash, timeout: TX_TIMEOUT_MS,
    });

    if (receipt.status !== 'success') {
      console.error(`[executor] TX reverted: ${txHash}`);
      await updateExecutionRecord(execRecordId, { status: 'failed', error: `TX reverted: ${txHash}` });
      await logActivity({
        walletId, type: 'sale', asset: token, assetSymbol: symbol,
        action: 'FAILED', reason: `TX reverted: ${txHash}`, txHash,
      });
      return { status: 'failed', reason: 'tx_reverted' };
    }

    console.log(`[executor] ✓ TX confirmed at block ${receipt.blockNumber}`);

    await updateExecutionRecord(execRecordId, {
      status: 'confirmed', confirmed_at: new Date().toISOString(),
    });

    await logActivity({
      walletId, type: 'sale', asset: token, assetSymbol: symbol,
      balance: formatUnits(balance, decimals),
      estimatedValue: formatUnits(currentValue, 18),
      invested: formatUnits(invested, 18),
      action: triggerType === 'stop_loss' ? 'SELL_ALL' : 'SELL_PROFIT',
      reason: triggerType === 'stop_loss' ? 'Stop loss executed' : 'Take profit executed',
      txHash, poolFee: freshQuote.fee,
    });

    await updateAssetStatus({
      walletId, asset: token, symbol,
      action: 'SOLD',
      reason: triggerType === 'stop_loss' ? 'Stop loss executed' : 'Take profit executed',
    });

    // Activate pause (24h)
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const newPauseUntil = Number(block.timestamp) + PAUSE_SECONDS;
    const currentState = await getRuntimeState(walletId);
    const existingPause = currentState ? Number(currentState.pause_until) : 0;
    const finalPause = Math.max(existingPause, newPauseUntil);

    await updateRuntimeState(walletId, { pause_until: finalPause });
    console.log(`[executor] Pause activated for wallet ${walletId} until ${new Date(finalPause * 1000).toISOString()}`);

    return { status: 'confirmed', txHash };

  } catch (err) {
    console.error(`[executor] Unexpected error:`, err.message);
    await updateExecutionRecord(execRecordId, { status: 'failed', error: err.message });
    return { status: 'failed', reason: err.message };
  } finally {
    await releaseLock(lockKey);
    const dedupKey = `sell:${chainId}:${contract.toLowerCase()}:${token.toLowerCase()}`;
    await clearDedup(dedupKey);
  }
}

// --------------------------------------------------
// Execute an invest job
// --------------------------------------------------

async function processInvestJob(job) {
  const { walletId, contractAddress, chainId } = job.data;

  const contract = getAddress(contractAddress);
  const lockKey = `lock:invest:${chainId}:${contract.toLowerCase()}`;

  const locked = await acquireLock(lockKey, LOCK_TTL_SECONDS);
  if (!locked) return { status: 'skipped', reason: 'lock_held' };

  try {
    const [paused, tradingPaused] = await Promise.all([
      readContract(contract, 'paused'),
      readContract(contract, 'tradingPaused'),
    ]);

    if (paused || tradingPaused) return { status: 'skipped', reason: 'contract_paused' };

    const runtimeState = await getRuntimeState(walletId);
    if (runtimeState && Math.floor(Date.now() / 1000) < Number(runtimeState.pause_until)) {
      return { status: 'skipped', reason: 'wallet_paused' };
    }

    const usdcAddress = getAddress(await readContract(contract, 'usdc'));
    const usdcBalance = await publicClient.readContract({
      address: usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [contract],
    });

    if (usdcBalance === 0n) return { status: 'skipped', reason: 'no_usdc' };

    console.log(`[executor] USDC balance: ${formatUnits(usdcBalance, 18)}`);

    await checkAgentRole(contract);

    if (DRY_RUN) {
      console.log(`[executor] [DRY RUN] Would send invest(paths, v4Pools)`);
      await logActivity({
        walletId, type: 'investment', action: 'SIMULATE_INVEST',
        reason: 'DRY_RUN — invest not executed',
      });
      return { status: 'simulated', reason: 'dry_run' };
    }

    // Build paths and v4Pools from contract config
    const assets = [];
    for (let i = 0; i < 100; i++) {
      try {
        const token = await readContract(contract, 'assets', [BigInt(i)]);
        if (token && token.toLowerCase() !== '0x0000000000000000000000000000000000000000') {
          assets.push(getAddress(token));
        }
      } catch { break; }
    }

    const v4PoolsArray = [];
    const paths = [];

    for (const token of assets) {
      try {
        const v4Pools = await readContract(contract, 'getV4Pools', [token]);
        v4PoolsArray.push(v4Pools || []);
        const path = await readContract(contract, 'assetPath', [token]);
        paths.push(path || '0x');
      } catch {
        v4PoolsArray.push([]);
        paths.push('0x');
      }
    }

    const nonce = await getNextNonce(publicClient, chainId, account.address);

    let request;
    try {
      const simResult = await publicClient.simulateContract({
        address: contract,
        abi: stockWalletAbi,
        functionName: 'invest',
        args: [paths, v4PoolsArray],
        account,
      });
      request = simResult.request;
    } catch (simError) {
      console.error(`[executor] Invest simulation failed:`, simError.shortMessage ?? simError.message);
      await rollbackNonce(chainId, account.address);
      await logActivity({
        walletId, type: 'investment', action: 'FAILED',
        reason: `Invest simulation reverted: ${simError.shortMessage ?? simError.message}`,
      });
      return { status: 'failed', reason: 'simulation_reverted' };
    }

    const txHash = await walletClient.writeContract({ ...request, nonce });
    console.log(`[executor] Invest TX sent: ${txHash}`);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash, timeout: TX_TIMEOUT_MS,
    });

    if (receipt.status !== 'success') {
      await logActivity({
        walletId, type: 'investment', action: 'FAILED',
        reason: `Invest TX reverted: ${txHash}`, txHash,
      });
      return { status: 'failed', reason: 'tx_reverted' };
    }

    console.log(`[executor] ✓ Invest confirmed at block ${receipt.blockNumber}`);

    await logActivity({
      walletId, type: 'investment', action: 'INVEST',
      reason: 'Investment executed after deposit', txHash,
    });

    return { status: 'confirmed', txHash };
  } catch (err) {
    console.error(`[executor] Invest error:`, err.message);
    return { status: 'failed', reason: err.message };
  } finally {
    await releaseLock(lockKey);
  }
}

// --------------------------------------------------
// Health check
// --------------------------------------------------

import { createServer } from 'http';

const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'executor', timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const HEALTH_PORT = Number(process.env.HEALTH_PORT || '3003');

// --------------------------------------------------
// Startup
// --------------------------------------------------

async function main() {
  console.log('[executor] Starting...');
  console.log(`[executor] RPC: ${BSC_RPC_URL}`);
  console.log(`[executor] Chain: BNB Chain (BSC, chainId: ${CHAIN_ID})`);
  console.log(`[executor] Signer: ${account.address}`);
  console.log(`[executor] Concurrency: ${EXECUTOR_CONCURRENCY}`);
  console.log(`[executor] DRY_RUN: ${DRY_RUN}`);

  await initDB();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID ${chainId}; expected BSC ${CHAIN_ID}`);
  }
  console.log(`[executor] Connected to BNB Chain (chainId: ${chainId})`);

  forceResync(chainId, account.address);

  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[executor] Health check on :${HEALTH_PORT}/health`);
  });

  const worker = new Worker(
    QUEUE_NAMES.EXECUTION,
    async (job) => {
      console.log(`[executor] Job ${job.id}: ${job.name}`);
      if (job.name === 'execute-sale') return processSellJob(job);
      if (job.name === 'execute-invest') return processInvestJob(job);
      console.warn(`[executor] Unknown job type: ${job.name}`);
    },
    {
      connection: redis,
      concurrency: EXECUTOR_CONCURRENCY,
    }
  );

  worker.on('completed', (job, result) => {
    console.log(`[executor] Job ${job.id} completed: ${result?.status || 'done'}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[executor] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[executor] Worker error:', err.message);
  });

  console.log('[executor] Worker started, waiting for jobs...');

  const shutdown = async () => {
    console.log('[executor] Shutting down...');
    await worker.close();
    healthServer.close();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[executor] Fatal:', err);
  process.exit(1);
});
