/**
 * abi.js — ABIs extraídas del contrato StockWallet compilado con Foundry.
 * Fuente: stockwallet/out/StockWallet.sol/StockWallet.json
 *
 * Incluye: StockWallet (V3+V4), ERC20, QuoterV2, QuoterV4.
 */

import { parseAbi, parseAbiItem } from 'viem';

// --------------------------------------------------
// StockWallet ABI (116 entradas — contrato completo)
// --------------------------------------------------
export const stockWalletAbi = parseAbi([
  // --- Roles ---
  'function ADGENT_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function getRoleAdmin(bytes32 role) view returns (bytes32)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function renounceRole(bytes32 role, address callerConfirmation)',

  // --- Ownership ---
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function renounceOwnership()',

  // --- Pause ---
  'function pause()',
  'function unpause()',
  'function paused() view returns (bool)',
  'function pauseTrading()',
  'function unpauseTrading()',
  'function tradingPaused() view returns (bool)',

  // --- Core: assets ---
  'function assets(uint256) view returns (address)',
  'function assetConfig(address) view returns (uint256 allocationBps, uint16 stopLossBps, uint16 takeProfitBps)',
  'function assetPosition(address) view returns (uint256 amount, uint256 invested)',
  'function assetPath(address) view returns (bytes)',
  'function getTokenConfig(address _token) view returns (tuple config)',
  'function addAsset(tuple _tokenToAdd, address _oldToken)',
  'function removeAsset(address _removedToken)',
  'function updateAllocation(address _token, uint256 _newAllocationBps)',
  'function updateRiskConfig(address _token, uint256 _stopLossBps, uint256 _takeProfitBps)',

  // --- Core: invest / sell ---
  'function invest(bytes[] _path, tuple[][] _v4Pools)',
  'function selltoken(address _token, bytes _path, tuple[] _v4Pools)',
  'function selltokenAll(bytes[] _path)',
  'function SellAssetOwner(address _token)',
  'function depositAsset(address _token, uint256 _amount, bytes _path)',
  'function withdrawAsset(address _token)',
  'function withdrawAssetUsdt(uint256 _amount)',

  // --- V4 pools ---
  'function getV4Pools(address _token) view returns (tuple[])',
  'function getV4SellPools(address _token) view returns (tuple[])',
  'function v4BuyPoolsByToken(address, uint256) view returns (address tokenIn, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)',
  'function v4SellPoolsByToken(address, uint256) view returns (address tokenIn, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)',
  'function setV4Pools(address _token, tuple[] _pools)',

  // --- Infrastructure addresses ---
  'function usdc() view returns (address)',
  'function gasToken() view returns (address)',
  'function setGasToken(address _gasToken)',
  'function factory() view returns (address)',
  'function poolManager() view returns (address)',
  'function quoter() view returns (address)',
  'function quoterV4() view returns (address)',
  'function v4Scanner() view returns (address)',
  'function PERMIT2() view returns (address)',
  'function UNIVERSAL_ROUTER() view returns (address)',

  // --- Config / params ---
  'function TOTAL_PERCENTAGE() view returns (uint16)',
  'function calculateMinimumOut(uint256 expectedOut) view returns (uint256)',
  'function updateAdgent(address _newAdgent)',
  'function updateAdgentContract(address _newAdgentContract)',
  'function updateAdgentPercentage(uint256 _newPercentage)',
  'function updateGasFee(uint256 _newGasFee)',
  'function updateslippageBps(uint256 _newslippageBps)',

  // --- Path helpers ---
  'function getFirstAddress(bytes _path) pure returns (address)',
  'function getLastAddress(bytes _path) pure returns (address)',

  // --- Misc ---
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function unlockCallback(bytes)',

  // --- Events ---
  'event AgentContractUpdated(address indexed oldAgentContract, address indexed newAgentContract)',
  'event AgentPercentageUpdated(uint256 oldPercentageBps, uint256 newPercentageBps)',
  'event AgentUpdated(address indexed oldAgent, address indexed newAgent)',
  'event AssetAdded(address indexed token, uint256 allocationBps)',
  'event AssetAllocationUpdated(address indexed token, uint256 oldAllocationBps, uint256 newAllocationBps)',
  'event AssetDeposited(address indexed user, address indexed token, uint256 amountDeposited, uint256 usdcReceived)',
  'event AssetPurchased(address indexed token, uint256 usdcSpent, uint256 tokensReceived)',
  'event AssetRemoved(address indexed token)',
  'event AssetRiskConfigUpdated(address indexed token, uint16 oldStopLossBps, uint16 newStopLossBps, uint16 oldTakeProfitBps, uint16 newTakeProfitBps)',
  'event AssetSold(address indexed token, uint256 tokensSold, uint256 usdcReceived)',
  'event AssetWithdrawn(address indexed token, address indexed recipient, uint256 amount)',
  'event GasFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps)',
  'event GasSwapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)',
  'event GasTokenUpdated(address indexed oldToken, address indexed newToken)',
  'event InvestmentExecuted(uint256 totalUsdc, uint256 gasFee, uint256 agentFee, uint256 totalInvested)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event Paused(address indexed account)',
  'event PoolNotFound(address indexed tokenIn, address indexed tokenOut)',
  'event QuoteFailed(address indexed tokenIn, address indexed tokenOut, uint24 fee, bytes reason)',
  'event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)',
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
  'event SellTokenByOwner(address indexed token, address indexed recipient, uint256 amount)',
  'event StopLossTriggered(address indexed token, uint256 tokensSold, uint256 usdcReceived, uint256 referenceInvested)',
  'event TakeProfitTriggered(address indexed token, uint256 tokensSold, uint256 usdcReceived, uint256 referenceInvested)',
  'event TradingPaused(address indexed account)',
  'event TradingUnpaused(address indexed account)',
  'event Unpaused(address indexed account)',
  'event UsdcWithdrawn(address indexed recipient, uint256 amount)',
  'event V4PoolsUpdated(address indexed token, uint256 poolCount)',
  'event slippageBpsUpdated(uint256 indexed oldslippageBps, uint256 newslippageBps)',
]);

// --------------------------------------------------
// ERC20 ABI
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
// Uniswap V3 QuoterV2 ABI
// --------------------------------------------------
export const quoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

// --------------------------------------------------
// Uniswap V4 Quoter ABI (placeholder — ajustar cuando se conozca la address real)
// --------------------------------------------------
export const quoterV4Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, int24 tickSpacing, address hooks, bytes hookData) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

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
