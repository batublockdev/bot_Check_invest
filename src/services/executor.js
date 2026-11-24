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
  MIN_INVEST_AMOUNT,
} from '../config.js';

import {
  stockWalletAbi,
  erc20Abi,
  quoterV2Abi,
  wbnbAbi,
} from '../lib/abi.js';

// --------------------------------------------------
// WBNB — BNB Chain
// --------------------------------------------------
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

// Gas management thresholds (in wei)
const MIN_BNB_THRESHOLD = 100000n * 10n ** 15n;      // 0.0001 BNB — mínimo para operar
const TARGET_BNB_BUFFER = 500000n * 10n ** 15n;       // 0.0005 BNB — buffer cómodo (10-20 TXs)
const UNWRAP_COST_BNB = 21000n * 10n ** 9n;           // ~0.000021 BNB @ 1 gwei — costo del unwrap
const UNWRAP_MAX_RATIO = 5n;                          // unwrap solo si costo < 5% del amount

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
// Gas management — WBNB unwrap inteligente
// --------------------------------------------------

/**
 * ensureGasBalance()
 *
 * Verifica el balance de BNB nativo del bot. Si es insuficiente para operar,
 * hace unwrap de WBNB → BNB.
 *
 * Estrategia:
 * - Si BNB >= MIN_BNB_THRESHOLD → no hace nada (tiene suficiente)
 * - Si BNB < MIN_BNB_THRESHOLD y hay WBNB disponible:
 *   - Calcula cuánto BNB necesita para llegar al TARGET_BNB_BUFFER
 *   - Verifica que el costo del unwrap (< 5% del amount a unwrap)
 *   - Si la relación es buena → unwrap
 *   - Si la relación es mala (poco WBNB) → log warning, no unwrap
 *
 * @returns {Object} { bnbBalance, wbnbBalance, unwrapped, skipped }
 */
async function ensureGasBalance() {
  // 1. Verificar balance BNB nativo
  const bnbBalance = await publicClient.getBalance({ address: account.address });

  // 2. Si tiene suficiente BNB → no hacer nada
  if (bnbBalance >= MIN_BNB_THRESHOLD) {
    return { bnbBalance, wbnbBalance: 0n, unwrapped: false, skipped: 'sufficient_bnb' };
  }

  // 3. Verificar balance WBNB
  const wbnbBalance = await publicClient.readContract({
    address: WBNB_ADDRESS,
    abi: wbnbAbi,
    functionName: 'balanceOf',
    args: [account.address],
  });

  if (wbnbBalance === 0n) {
    console.warn(`[executor] ⚠️ BNB bajo (${formatUnits(bnbBalance, 18)} BNB) y sin WBNB para unwrap`);
    return { bnbBalance, wbnbBalance: 0n, unwrapped: false, skipped: 'no_wbnb' };
  }

  // 4. Calcular cuánto unwrap
  const bnbNeeded = TARGET_BNB_BUFFER - bnbBalance;
  const amountToUnwrap = wbnbBalance >= bnbNeeded ? bnbNeeded : wbnbBalance;

  // 5. Verificar relación costo/beneficio
  //    costo unwrap = UNWRAP_COST_BNB
  //    beneficio = amountToUnwrap
  //    Si costo > 5% del amount → no vale la pena

  if (amountToUnwrap <= UNWRAP_COST_BNB) {
    console.warn(
      `[executor] ⚠️ WBNB muy poco (${formatUnits(wbnbBalance, 18)} BNB) — ` +
      `unwrap costaría más de lo que recibiría. Acumulando...`
    );
    return { bnbBalance, wbnbBalance, unwrapped: false, skipped: 'insufficient_wbnb' };
  }

  const costRatio = (UNWRAP_COST_BNB * 100n) / amountToUnwrap;
  if (costRatio > UNWRAP_MAX_RATIO) {
    console.warn(
      `[executor] ⚠️ Unwrap no rentable: costo ${formatUnits(UNWRAP_COST_BNB, 18)} BNB ` +
      `vs ${formatUnits(amountToUnwrap, 18)} BNB (${costRatio}%). Acumulando WBNB...`
    );
    return { bnbBalance, wbnbBalance, unwrapped: false, skipped: 'not_profitable' };
  }

  // 6. Ejecutar unwrap: WBNB.withdraw(amount)
  console.log(
    `[executor] Unwrapping ${formatUnits(amountToUnwrap, 18)} WBNB → BNB ` +
    `(bnb: ${formatUnits(bnbBalance, 18)}, wbnb: ${formatUnits(wbnbBalance, 18)})`
  );

  const nonce = await getNextNonce(publicClient, CHAIN_ID, account.address);

  try {
    const txHash = await walletClient.writeContract({
      address: WBNB_ADDRESS,
      abi: wbnbAbi,
      functionName: 'withdraw',
      args: [amountToUnwrap],
      nonce,
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: TX_TIMEOUT_MS,
    });

    if (receipt.status !== 'success') {
      console.error(`[executor] Unwrap TX reverted: ${txHash}`);
      await rollbackNonce(CHAIN_ID, account.address);
      return { bnbBalance, wbnbBalance, unwrapped: false, skipped: 'tx_reverted' };
    }

    const newBnbBalance = await publicClient.getBalance({ address: account.address });
    console.log(
      `[executor] ✓ Unwrap confirmado: BNB ${formatUnits(bnbBalance, 18)} → ${formatUnits(newBnbBalance, 18)}`
    );

    return { bnbBalance: newBnbBalance, wbnbBalance, unwrapped: true, txHash };
  } catch (err) {
    console.error(`[executor] Unwrap failed:`, err.shortMessage ?? err.message);
    await rollbackNonce(CHAIN_ID, account.address);
    return { bnbBalance, wbnbBalance, unwrapped: false, skipped: 'unwrap_failed' };
  }
}

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

  // Ensure bot has enough BNB for gas before executing
  await ensureGasBalance();

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

  // Ensure bot has enough BNB for gas before executing
  await ensureGasBalance();

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

    console.log(`[executor] USDT balance: ${formatUnits(usdcBalance, 18)}`);

    // Minimum invest check — skip if balance < 0.1 USDT
    // Gas cost of an invest TX (~100k gas @ 1 gwei = ~0.0001 BNB ≈ $0.05)
    // is not worth it for amounts < 0.1 USDT
    if (usdcBalance < MIN_INVEST_AMOUNT) {
      console.log(
        `[executor] USDT balance (${formatUnits(usdcBalance, 18)}) < minimum (${formatUnits(MIN_INVEST_AMOUNT, 18)}) — skipping invest, not worth gas cost`
      );
      await logActivity({
        walletId, type: 'investment', action: 'SKIPPED',
        reason: `Balance too low: ${formatUnits(usdcBalance, 18)} USDT < ${formatUnits(MIN_INVEST_AMOUNT, 18)} minimum`,
      });
      return { status: 'skipped', reason: 'below_min_invest' };
    }

    await checkAgentRole(contract);

    if (DRY_RUN) {
      console.log(`[executor] [DRY RUN] Would send invest(paths, v4Pools)`);
      await logActivity({
        walletId, type: 'investment', action: 'SIMULATE_INVEST',
        reason: 'DRY_RUN — invest not executed',
      });
      return { status: 'simulated', reason: 'dry_run' };
    }

    // Build paths and v4Pools from contract config.
    // Key: if no asset has V4 pools configured, pass EMPTY arrays
    // (not arrays of empty values) so the contract uses V3 automatically.
    // This matches the test pattern: invest(new bytes[](0), new V4PoolData[][](0))
    const assets = [];
    for (let i = 0; i < 100; i++) {
      try {
        const token = await readContract(contract, 'assets', [BigInt(i)]);
        if (token && token.toLowerCase() !== '0x0000000000000000000000000000000000000000') {
          assets.push(getAddress(token));
        }
      } catch { break; }
    }

    // Check which assets have V4 pools configured on-chain
    const v4PoolsArray = [];
    const paths = [];
    let hasAnyV4 = false;

    for (const token of assets) {
      let v4Pools = [];
      let path = '0x';

      try {
        v4Pools = await readContract(contract, 'getV4Pools', [token]);
        if (!v4Pools) v4Pools = [];
        if (v4Pools.length > 0) hasAnyV4 = true;
      } catch { /* no V4 pools */ }

      try {
        const rawPath = await readContract(contract, 'assetPath', [token]);
        if (rawPath && rawPath !== '0x') path = rawPath;
      } catch { /* default 0x */ }

      v4PoolsArray.push(v4Pools);
      paths.push(path);
    }

    // If no asset has V4 pools AND no asset has a real path,
    // pass completely empty arrays so the contract uses V3 only.
    const hasAnyRealPath = paths.some(p => p !== '0x');
    const finalPaths = (hasAnyV4 || hasAnyRealPath) ? paths : [];
    const finalV4Pools = (hasAnyV4 || hasAnyRealPath) ? v4PoolsArray : [];

    console.log(`[executor] Assets: ${assets.length}, V4 pools: ${hasAnyV4}, real paths: ${hasAnyRealPath}`);
    console.log(`[executor] invest args: paths=${finalPaths.length}, v4Pools=${finalV4Pools.length}`);

    const nonce = await getNextNonce(publicClient, chainId, account.address);

    let request;
    try {
      const simResult = await publicClient.simulateContract({
        address: contract,
        abi: stockWalletAbi,
        functionName: 'invest',
        args: [finalPaths, finalV4Pools],
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
