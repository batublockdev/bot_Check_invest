/**
 * abi.js — ABIs para StockWallet bot en BSC.
 * Usa el ABI crudo en formato JSON (no parseAbi) porque viem/abitype
 * no soporta `tuple` en formato human-readable.
 *
 * Fuente: stockwallet/out/StockWallet.sol/StockWallet.json (Foundry)
 */

import { parseAbi, parseAbiItem } from 'viem';

// StockWallet ABI — formato JSON crudo desde Foundry (115 entradas)
// Incluye funciones con tuples (addAsset, invest, selltoken, getV4Pools, etc.)
import stockWalletRawAbi from './StockWallet.abi.json' with { type: 'json' };

export const stockWalletAbi = stockWalletRawAbi;

// --------------------------------------------------
// ERC20 ABI (sin tuples — parseAbi funciona)
// --------------------------------------------------
export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

// --------------------------------------------------
// Uniswap V3 QuoterV2 ABI (sin tuples anidados problemáticos)
// --------------------------------------------------
export const quoterV2Abi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        internalType: 'struct IQuoterV2.QuoteExactInputSingleParams',
        components: [
          { name: 'tokenIn', type: 'address', internalType: 'address' },
          { name: 'tokenOut', type: 'address', internalType: 'address' },
          { name: 'amountIn', type: 'uint256', internalType: 'uint256' },
          { name: 'fee', type: 'uint24', internalType: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160', internalType: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256', internalType: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160', internalType: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32', internalType: 'uint32' },
      { name: 'gasEstimate', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
];

// --------------------------------------------------
// Eventos individuales (para getLogs)
// --------------------------------------------------
export const assetDepositedEvent = parseAbiItem(
  'event AssetDeposited(address indexed user, address indexed token, uint256 amountDeposited, uint256 usdcReceived)'
);

export const assetSoldEvent = parseAbiItem(
  'event AssetSold(address indexed token, uint256 tokensSold, uint256 usdcReceived)'
);

export const assetPurchasedEvent = parseAbiItem(
  'event AssetPurchased(address indexed token, uint256 usdcSpent, uint256 tokensReceived)'
);

export const stopLossTriggeredEvent = parseAbiItem(
  'event StopLossTriggered(address indexed token, uint256 tokensSold, uint256 usdcReceived, uint256 referenceInvested)'
);

export const takeProfitTriggeredEvent = parseAbiItem(
  'event TakeProfitTriggered(address indexed token, uint256 tokensSold, uint256 usdcReceived, uint256 referenceInvested)'
);

export const investmentExecutedEvent = parseAbiItem(
  'event InvestmentExecuted(uint256 totalUsdc, uint256 gasFee, uint256 agentFee, uint256 totalInvested)'
);

export const gasSwappedEvent = parseAbiItem(
  'event GasSwapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)'
);
