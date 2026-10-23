import 'dotenv/config';

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  formatUnits,
} from 'viem';

import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { withAttribution } from '@celo/attribution-tags';

import {
  stockWalletAbi,
  erc20Abi,
  quoterV2Abi,
  assetDepositedEvent,
  assetSoldEvent,
  stopLossTriggeredEvent,
  takeProfitTriggeredEvent,
} from './abi.js';

import {
  initDB,
  loadState,
  saveState,
  initState,
  closeDB,
} from './db.js';

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const {
  CELO_RPC_URL = 'https://forno.celo.org',
  TAG_ATTRIBUTION,
  STOCKWALLET_ADDRESS,
  UNISWAP_QUOTER_ADDRESS,
  BOT_PRIVATE_KEY,
  DRY_RUN: DRY_RUN_ENV = 'true',
  POLL_INTERVAL_MS: POLL_ENV = '15000',
  BLOCK_RANGE: RANGE_ENV = '1000',
} = process.env;

if (!STOCKWALLET_ADDRESS) {
  throw new Error('STOCKWALLET_ADDRESS missing in .env');
}

if (!UNISWAP_QUOTER_ADDRESS) {
  throw new Error('UNISWAP_QUOTER_ADDRESS missing in .env');
}

if (!BOT_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(BOT_PRIVATE_KEY)) {
  throw new Error('BOT_PRIVATE_KEY missing or invalid.');
}

const STOCK_ADDRESS = getAddress(STOCKWALLET_ADDRESS);
const QUOTER_ADDRESS = getAddress(UNISWAP_QUOTER_ADDRESS);
const MIN_INVEST_USDT = 1n;
const MIN_INVEST_HUMAN = '0.01';
const DRY_RUN = DRY_RUN_ENV.toLowerCase() === 'true';
const POLL_INTERVAL_MS = Number(POLL_ENV);
const BLOCK_RANGE = BigInt(RANGE_ENV);

const PAUSE_SECONDS = 24 * 60 * 60;
const BPS = 10_000n;
const FEE_TIERS = [100, 500, 3000, 10000];

if (
  !Number.isFinite(POLL_INTERVAL_MS) ||
  POLL_INTERVAL_MS < 1000
) {
  throw new Error('POLL_INTERVAL_MS must be at least 1000.');
}

if (BLOCK_RANGE < 1n) {
  throw new Error('BLOCK_RANGE must be greater than zero.');
}

const account = privateKeyToAccount(BOT_PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: celo,
  transport: http(CELO_RPC_URL),
}).extend(
  withAttribution(TAG_ATTRIBUTION)
);

let busy = false;
let state = null;

// --------------------------------------------------
// PERSISTENT STATE (PostgreSQL)
// --------------------------------------------------

function eventKey(log) {
  return `${log.transactionHash}-${log.logIndex}`;
}

function isPaused() {
  return Math.floor(Date.now() / 1000) < state.pauseUntil;
}

function logPauseStatus() {
  if (isPaused()) {
    console.log(
      `Pause active. ${state.pauseUntil - Math.floor(Date.now() / 1000)} seconds remaining.`
    );
  }
}

async function initialize() {
  await initDB();

  state = await loadState();

  if (state) {
    const lastBlock = BigInt(state.lastProcessedBlock);
    const latestBlock = await publicClient.getBlockNumber();

    // If lastProcessedBlock is 0 or unreasonably old, start from current block.
    // This prevents scanning millions of historical blocks on first run.
    if (lastBlock === 0n || (latestBlock - lastBlock) > BigInt(BLOCK_RANGE * 100n)) {
      console.log(`Last block ${lastBlock} is too old or zero. Resetting to current block ${latestBlock}.`);
      state.lastProcessedBlock = latestBlock.toString();
      await saveState(state);
    }

    console.log(`State loaded from DB. Last block: ${state.lastProcessedBlock}.`);
    return;
  }

  // First startup: don't process historical deposits.
  const latestBlock = await publicClient.getBlockNumber();

  await initState(latestBlock.toString());
  state = await loadState();

  console.log(`State initialized at block ${latestBlock}.`);
}

// --------------------------------------------------
// AUTOMATIC 24-HOUR PAUSE
// --------------------------------------------------

async function activatePauseFromBlock(blockNumber) {
  const block = await publicClient.getBlock({ blockNumber });
  const eventTimestamp = Number(block.timestamp);

  const newPauseUntil = eventTimestamp + PAUSE_SECONDS;

  state.pauseUntil = Math.max(state.pauseUntil, newPauseUntil);
  await saveState(state);

  console.log(
    `Pause activated until ${new Date(state.pauseUntil * 1000).toISOString()}`
  );
}

async function activatePauseFromReceipt(receipt) {
  const block = await publicClient.getBlock({
    blockNumber: receipt.blockNumber,
  });

  state.pauseUntil = Math.max(
    state.pauseUntil,
    Number(block.timestamp) + PAUSE_SECONDS,
  );

  await saveState(state);

  console.log(
    `Pause activated after sale until ${new Date(state.pauseUntil * 1000).toISOString()}`
  );
}

// --------------------------------------------------
// UNISWAP V3 QUOTING
// --------------------------------------------------

async function quoteBest(tokenIn, tokenOut, amountIn) {
  let best = null;

  for (const fee of FEE_TIERS) {
    try {
      const result = await publicClient.readContract({
        address: QUOTER_ADDRESS,
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
      // Pool at this fee tier may not exist or have liquidity.
    }
  }

  if (!best) {
    throw new Error(`Could not quote ${tokenIn} -> ${tokenOut}`);
  }

  return best;
}

// --------------------------------------------------
// AUTOMATIC INVESTMENT ON DEPOSIT
// --------------------------------------------------

async function investAfterDeposit(log) {
  console.log('Deposit detected:', {
    user: log.args.user,
    token: log.args.token,
    amountDeposited: log.args.amountDeposited?.toString(),
    block: log.blockNumber?.toString(),
  });

  if (isPaused()) {
    console.log('Investment skipped: pause is active.');
    return;
  }

  if (DRY_RUN) {
    console.log('[DRY RUN] Not sending invest([]).');
    return;
  }

  await checkAgentRole();

  const { request } = await publicClient.simulateContract({
    address: STOCK_ADDRESS,
    abi: stockWalletAbi,
    functionName: 'invest',
    args: [[]],
    account,
  });

  const hash = await walletClient.writeContract(request);

  console.log('Investment sent:', hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') {
    throw new Error(`Investment reverted: ${hash}`);
  }

  console.log(
    `Investment confirmed at block ${receipt.blockNumber}.`
  );
}

// --------------------------------------------------
// READ REGISTERED ASSETS
// --------------------------------------------------

async function getRegisteredAssets() {
  const assets = [];

  for (let i = 0; i < 100; i++) {
    try {
      const token = await readStock('assets', [BigInt(i)]);

      if (
        token &&
        token.toLowerCase() !==
        '0x0000000000000000000000000000000000000000'
      ) {
        assets.push(getAddress(token));
      }
    } catch (error) {
      const message = String(error?.shortMessage ?? error?.message ?? '');

      if (/network|timeout|rate|429|server error/i.test(message)) {
        throw error;
      }

      // Array getter out of range: done scanning.
      break;
    }
  }

  if (assets.length === 100) {
    console.warn('Warning: reached the 100-asset limit.');
  }

  return [...new Set(assets)];
}

// --------------------------------------------------
// EVALUATE AND EXECUTE AUTOMATIC SALES
// --------------------------------------------------

async function processToken(token, baseToken, baseDecimals) {
  if (isPaused()) return 'PAUSED';

  const [
    symbol,
    decimals,
    balance,
    position,
    config,
  ] = await Promise.all([
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

    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [STOCK_ADDRESS],
    }),

    readStock('assetPosition', [token]),

    readStock('assetConfig', [token]),
  ]);

  const invested = BigInt(position[1]);
  const stopLossBps = BigInt(config[1]);
  const takeProfitBps = BigInt(config[2]);

  console.log(`\nAsset: ${symbol} (${token})`);

  if (balance === 0n || invested === 0n) {
    console.log('No balance or registered investment; skipping.');
    return 'IGNORE';
  }

  const quote = await quoteBest(token, baseToken, balance);
  const currentValue = quote.amountOut;

  const belowStop =
    stopLossBps > 0n &&
    currentValue * BPS <= invested * stopLossBps;

  const aboveTake =
    takeProfitBps > 0n &&
    currentValue * BPS >= invested * takeProfitBps;

  let action = 'IGNORE';

  if (belowStop) {
    action = 'SELL_ALL';
  } else if (aboveTake) {
    action = 'SELL_PROFIT';
  }

  console.log(
    `  Balance: ${formatUnits(balance, decimals)} ${symbol}`
  );

  console.log(
    `  Estimated value: ${formatUnits(currentValue, baseDecimals)} base token`
  );

  console.log(
    `  Invested: ${formatUnits(invested, baseDecimals)} base token`
  );

  console.log(`  Quoted pool fee: ${quote.fee}`);
  console.log(`  Action: ${action}`);

  if (action === 'IGNORE') return action;

  // The contract calculates how much to sell.
  // The bot only decides when to attempt the sale.
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would attempt selltoken(${token}, '0x').`);
    return action;
  }

  if (isPaused()) {
    console.log('Sale cancelled: pause is active.');
    return 'PAUSED';
  }

  await checkAgentRole();

  const { request } = await publicClient.simulateContract({
    address: STOCK_ADDRESS,
    abi: stockWalletAbi,
    functionName: 'selltoken',
    args: [token, '0x'],
    account,
  });

  const hash = await walletClient.writeContract(request);

  console.log('Sale sent:', hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') {
    throw new Error(`Sale reverted: ${hash}`);
  }

  console.log(`Sale confirmed at block ${receipt.blockNumber}.`);

  // Pause immediately, without waiting for the next log cycle.
  await activatePauseFromReceipt(receipt);

  return 'SOLD';
}

async function checkUsdtBalanceTrigger() {
  if (isPaused()) {
    console.log('Pause active: not investing.');
    return;
  }

  const token = getAddress(await readStock('usdc'));

  const [balance, decimals, symbol] = await Promise.all([
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [STOCK_ADDRESS],
    }),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'symbol',
    }).catch(() => 'USDT'),
  ]);

  const minimum = BigInt(
    Math.round(Number(MIN_INVEST_HUMAN) * 10 ** Number(decimals))
  );

  console.log(
    `Current balance: ${formatUnits(balance, decimals)} ${symbol}`
  );

  if (balance < minimum) {
    console.log(`Balance below minimum of ${MIN_INVEST_HUMAN} ${symbol}.`);
    return;
  }

  if (DRY_RUN) {
    console.log('[DRY RUN] Balance meets minimum; not sending investment.');
    return;
  }

  await checkAgentRole();

  const { request } = await publicClient.simulateContract({
    address: STOCK_ADDRESS,
    abi: stockWalletAbi,
    functionName: 'invest',
    args: [[]],
    account,
  });

  const hash = await walletClient.writeContract(request);
  console.log('Balance-triggered investment sent:', hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success') {
    throw new Error(`Investment reverted: ${hash}`);
  }

  console.log('Investment confirmed.');
}

async function runSellCycle() {
  if (isPaused()) {
    logPauseStatus();
    console.log('Automatic sales suspended.');
    return;
  }

  const baseToken = getAddress(await readStock('usdc'));

  const baseDecimals = await publicClient.readContract({
    address: baseToken,
    abi: erc20Abi,
    functionName: 'decimals',
  });

  const assets = await getRegisteredAssets();

  console.log(`Registered assets: ${assets.length}`);

  for (const token of assets) {
    if (isPaused()) {
      console.log('Pause active; stopping asset scan.');
      break;
    }

    try {
      const result = await processToken(token, baseToken, baseDecimals);

      // Don't sell other assets after executing a sale.
      if (result === 'SOLD' || result === 'PAUSED') break;
    } catch (error) {
      console.error(
        `Error processing ${token}:`,
        error.shortMessage ?? error.message
      );
    }
  }
}

// --------------------------------------------------
// CONTRACT EVENT LISTENING
// --------------------------------------------------

async function fetchLogs(fromBlock, toBlock) {
  const [
    deposits,
    sold,
    stopLoss,
    takeProfit,
  ] = await Promise.all([
    publicClient.getLogs({
      address: STOCK_ADDRESS,
      event: assetDepositedEvent,
      fromBlock,
      toBlock,
    }),

    publicClient.getLogs({
      address: STOCK_ADDRESS,
      event: assetSoldEvent,
      fromBlock,
      toBlock,
    }),

    publicClient.getLogs({
      address: STOCK_ADDRESS,
      event: stopLossTriggeredEvent,
      fromBlock,
      toBlock,
    }),

    publicClient.getLogs({
      address: STOCK_ADDRESS,
      event: takeProfitTriggeredEvent,
      fromBlock,
      toBlock,
    }),
  ]);

  const logs = [
    ...deposits.map((log) => ({ ...log, kind: 'deposit' })),
    ...sold.map((log) => ({ ...log, kind: 'sale' })),
    ...stopLoss.map((log) => ({ ...log, kind: 'sale' })),
    ...takeProfit.map((log) => ({ ...log, kind: 'sale' })),
  ];

  logs.sort((a, b) => {
    const blockA = a.blockNumber ?? 0n;
    const blockB = b.blockNumber ?? 0n;

    if (blockA !== blockB) return blockA < blockB ? -1 : 1;

    const indexA = a.logIndex ?? 0;
    const indexB = b.logIndex ?? 0;

    return indexA - indexB;
  });

  return logs;
}

async function processRange(fromBlock, toBlock) {
  const logs = await fetchLogs(fromBlock, toBlock);

  for (const log of logs) {
    const key = eventKey(log);

    if (state.processedEvents.includes(key)) continue;

    if (log.kind === 'sale') {
      await activatePauseFromBlock(log.blockNumber);

      console.log('Sale event detected; pause activated.');
    } else if (log.kind === 'deposit') {
      await investAfterDeposit(log);
    }

    state.processedEvents.push(key);

    if (state.processedEvents.length > 5000) {
      state.processedEvents = state.processedEvents.slice(-3000);
    }

    await saveState(state);
  }

  state.lastProcessedBlock = toBlock.toString();
  await saveState(state);
}

async function syncEvents() {
  const latestBlock = await publicClient.getBlockNumber();

  let fromBlock = BigInt(state.lastProcessedBlock) + 1n;

  while (fromBlock <= latestBlock) {
    const toBlock =
      fromBlock + BLOCK_RANGE - 1n < latestBlock
        ? fromBlock + BLOCK_RANGE - 1n
        : latestBlock;

    await processRange(fromBlock, toBlock);

    fromBlock = toBlock + 1n;
  }
}

// --------------------------------------------------
// CONTRACT READ HELPER
// --------------------------------------------------

async function readStock(functionName, args = []) {
  return publicClient.readContract({
    address: STOCK_ADDRESS,
    abi: stockWalletAbi,
    functionName,
    args,
  });
}

async function checkAgentRole() {
  const role = await readStock('ADGENT_ROLE');

  const authorized = await readStock('hasRole', [
    role,
    account.address,
  ]);

  if (!authorized) {
    throw new Error(
      `Account ${account.address} does not have ADGENT_ROLE.`
    );
  }

  return true;
}

// --------------------------------------------------
// MAIN LOOP
// --------------------------------------------------

async function runOnce() {
  if (busy) return;

  busy = true;

  try {
    const chainId = await publicClient.getChainId();

    if (chainId !== 42220) {
      throw new Error(
        `Chain ID ${chainId}; expected Celo 42220.`
      );
    }

    // 1. Detect new events, including deposits.
    await syncEvents();

    // 2. Check if there's base token balance to invest.
    if (!isPaused()) {
      await checkUsdtBalanceTrigger();
    } else {
      logPauseStatus();
    }

    // 3. Evaluate stop-loss and take-profit.
    if (!isPaused()) {
      await runSellCycle();
    }

  } catch (error) {
    console.error(
      '[ERROR]',
      error.shortMessage ?? error.message
    );
  } finally {
    busy = false;
  }
}

async function main() {
  console.log('Starting StockWallet Bot...');
  console.log('Contract:', STOCK_ADDRESS);
  console.log('Bot account:', account.address);
  console.log('DRY_RUN:', DRY_RUN);
  console.log('Attribution:', TAG_ATTRIBUTION);

  await initialize();

  const chainId = await publicClient.getChainId();

  if (chainId !== 42220) {
    throw new Error(`Chain ID ${chainId}; expected Celo mainnet.`);
  }

  await checkAgentRole();

  console.log('ADGENT_ROLE verified.');
  console.log('Interval:', POLL_INTERVAL_MS, 'ms');

  await runOnce();

  setInterval(() => {
    runOnce().catch((error) => {
      console.error('[CYCLE]', error);
    });
  }, POLL_INTERVAL_MS);
}

main().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exitCode = 1;
});

// Close DB cleanly on exit
process.on('SIGTERM', async () => {
  console.log('[SIGTERM] Closing connections...');
  await closeDB();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SIGINT] Closing connections...');
  await closeDB();
  process.exit(0);
});