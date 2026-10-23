import { parseAbi, parseAbiItem } from 'viem';

export const stockWalletAbi = parseAbi([
  'function usdc() view returns (address)',
  'function assets(uint256) view returns (address)',
  'function assetPosition(address) view returns (uint256 amount, uint256 invested)',
  'function assetConfig(address) view returns (uint256 allocationBps, uint256 stopLossBps, uint256 takeProfitBps)',
  'function ADGENT_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function selltoken(address _token, bytes _path)',
  'function invest(bytes[] _path)',
  'function ADGENT_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
]);

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

export const quoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);



export const assetDepositedEvent = parseAbiItem(
  'event AssetDeposited(address indexed user, address indexed token, uint256 amountDeposited, uint256 usdcReceived)'
);

export const assetSoldEvent = parseAbiItem(
  'event AssetSold(address indexed token, uint256 amountSold, uint256 amountOut)'
);

export const stopLossTriggeredEvent = parseAbiItem(
  'event StopLossTriggered(address indexed token, uint256 amountSold, uint256 amountOut, uint256 invested)'
);

export const takeProfitTriggeredEvent = parseAbiItem(
  'event TakeProfitTriggered(address indexed token, uint256 amountSold, uint256 amountOut, uint256 invested)'
);

export const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);