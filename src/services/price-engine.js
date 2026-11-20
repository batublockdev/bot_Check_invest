/**
 * price-engine.js — Servicio independiente de cotización de precios.
 * BNB Chain (BSC) — Chain ID 56.
 *
 * Responsabilidades:
 * 1. Cargar mercados activos desde PostgreSQL
 * 2. Cotizar con Uniswap V3 (QuoterV2) y V4 (QuoterV4) cuando esté disponible
 * 3. Guardar snapshots en Redis (cache TTL 30s)
 * 4. Encolar jobs de evaluación en BullMQ agrupados por mercado
 *
 * Uso: npm run price-engine
 */

import { createPublicClient, http, getAddress } from 'viem';
import { bsc } from 'viem/chains';
import { Queue } from 'bullmq';

import {
  BSC_RPC_URL,
  UNISWAP_QUOTER_ADDRESS,
  PRICE_POLL_INTERVAL_MS,
  FEE_TIERS_V3,
  SNAPSHOT_TTL_SECONDS,
  QUEUE_NAMES,
  CHAIN_ID,
} from '../config.js';

import { quoterV2Abi } from '../lib/abi.js';
import { initDB, getActiveMarkets, savePriceSnapshot } from '../lib/db.js';
import { redis, cacheSnapshot } from '../lib/redis.js';

// --------------------------------------------------
// Public client (read-only) — BSC
// --------------------------------------------------

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC_URL),
});

// --------------------------------------------------
// BullMQ evaluation queue
// --------------------------------------------------

const evaluationQueue = new Queue(QUEUE_NAMES.EVALUATION, {
  connection: redis,
});

// --------------------------------------------------
// V3 Quoting (Uniswap V3 QuoterV2 on BSC)
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
        best = { fee, amountOut, source: 'v3' };
      }
    } catch {
      // Pool at this fee tier may not exist or have liquidity
    }
  }

  return best;
}

// --------------------------------------------------
// V4 Quoting (placeholder — activar cuando quoterV4 address esté confirmada)
// --------------------------------------------------

async function quoteBestV4(tokenIn, tokenOut, amountIn, quoterV4Address) {
  if (!quoterV4Address) return null;
  // TODO: Implementar cuando se confirme la address del QuoterV4 en BSC
  return null;
}

// --------------------------------------------------
// Quote a single market and return snapshot
// --------------------------------------------------

async function quoteMarket(market) {
  const tokenIn = getAddress(market.token_in);
  const tokenOut = getAddress(market.token_out);

  // Reference amount: 1 unit with 18 decimals
  const refAmount = 10n ** 18n;

  // V3 quote
  const v3Result = await quoteBestV3(tokenIn, tokenOut, refAmount);

  // V4 quote (if available)
  const v4Result = await quoteBestV4(tokenIn, tokenOut, refAmount, null);

  let best = null;
  if (v3Result && (!v4Result || v3Result.amountOut > v4Result.amountOut)) {
    best = v3Result;
  } else if (v4Result) {
    best = v4Result;
  }

  if (!best) {
    console.warn(`[price-engine] No quote for ${market.token_in} -> ${market.token_out}`);
    return null;
  }

  const blockNumber = await publicClient.getBlockNumber();

  const snapshot = {
    marketId: market.id,
    tokenIn,
    tokenOut,
    pricePerUnit: best.amountOut.toString(),
    fee: best.fee || null,
    source: best.source,
    blockNumber: blockNumber.toString(),
    timestamp: Date.now(),
  };

  return snapshot;
}

// --------------------------------------------------
// Main cycle
// --------------------------------------------------

async function runPriceCycle() {
  console.log(`[price-engine] Cycle started at ${new Date().toISOString()}`);

  let markets;
  try {
    markets = await getActiveMarkets();
  } catch (err) {
    console.error('[price-engine] Failed to load markets:', err.message);
    return;
  }

  if (markets.length === 0) {
    console.warn('[price-engine] No active markets found. Register markets in PostgreSQL.');
    return;
  }

  console.log(`[price-engine] Quoting ${markets.length} markets...`);

  let quoted = 0;
  let failed = 0;

  for (const market of markets) {
    try {
      const snapshot = await quoteMarket(market);

      if (!snapshot) {
        failed++;
        continue;
      }

      const marketKey = `${market.chain_id}:${market.token_in}:${market.token_out}`;
      await cacheSnapshot(marketKey, snapshot, SNAPSHOT_TTL_SECONDS);

      await savePriceSnapshot({
        marketId: market.id,
        price: snapshot.pricePerUnit,
        blockNumber: snapshot.blockNumber,
        source: snapshot.source,
        metadata: { fee: snapshot.fee },
      });

      await evaluationQueue.add('evaluate-market', {
        marketId: market.id,
        chainId: market.chain_id,
        tokenIn: snapshot.tokenIn,
        tokenOut: snapshot.tokenOut,
        pricePerUnit: snapshot.pricePerUnit,
        fee: snapshot.fee,
        source: snapshot.source,
        blockNumber: snapshot.blockNumber,
        timestamp: snapshot.timestamp,
      }, {
        jobId: `market-${market.id}-${snapshot.blockNumber}`,
        removeOnComplete: 100,
        removeOnFail: 50,
      });

      quoted++;
      console.log(`[price-engine] ✓ ${market.token_in.slice(0,8)}... -> ${market.token_out.slice(0,8)}... | fee: ${snapshot.fee}`);
    } catch (err) {
      console.error(`[price-engine] Error quoting market ${market.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[price-engine] Cycle done: ${quoted} quoted, ${failed} failed`);
}

// --------------------------------------------------
// Health check endpoint for Railway
// --------------------------------------------------

import { createServer } from 'http';

const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'price-engine', timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const HEALTH_PORT = Number(process.env.HEALTH_PORT || '3001');

// --------------------------------------------------
// Startup
// --------------------------------------------------

async function main() {
  console.log('[price-engine] Starting...');
  console.log(`[price-engine] RPC: ${BSC_RPC_URL}`);
  console.log(`[price-engine] Chain: BNB Chain (BSC, chainId: ${CHAIN_ID})`);
  console.log(`[price-engine] Quoter V3: ${UNISWAP_QUOTER_ADDRESS}`);
  console.log(`[price-engine] Poll interval: ${PRICE_POLL_INTERVAL_MS}ms`);

  await initDB();

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`Chain ID ${chainId}; expected BSC ${CHAIN_ID}`);
  }
  console.log(`[price-engine] Connected to BNB Chain (chainId: ${chainId})`);

  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[price-engine] Health check on :${HEALTH_PORT}/health`);
  });

  await runPriceCycle();

  const interval = setInterval(() => {
    runPriceCycle().catch((err) => {
      console.error('[price-engine] Cycle error:', err.message);
    });
  }, PRICE_POLL_INTERVAL_MS);

  const shutdown = async () => {
    console.log('[price-engine] Shutting down...');
    clearInterval(interval);
    healthServer.close();
    await evaluationQueue.close();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[price-engine] Fatal:', err);
  process.exit(1);
});
