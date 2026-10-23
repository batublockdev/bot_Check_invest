# StockWallet bot (Celo / Node.js)

Starter bot that polls every 60 seconds, quotes token balances into the StockWallet's USDC using Uniswap V3 QuoterV2, reads `assetPosition` and `assetConfig`, and in live mode calls `selltoken(token, path)` when the configured contract thresholds are reached.

## Important limits

- The public contract source has `selltoken(address,bytes)` and `invest(bytes[])`. `invest` distributes USDC across all configured assets; it is **not** a single-token buy function. This bot intentionally does not execute buys.
- `selltoken` is authorized with `ADGENT_ROLE`. The configured signer must have this role on the deployed contract.
- Confirm the deployed contract ABI and QuoterV2 address. The Quoter ABI in this project uses the QuoterV2 tuple signature. If your Celo deployment exposes a different ABI, adjust `src/abi.js`.
- This is a starter, not audited trading software. Test on a fork/test environment before mainnet execution.

## Install

```bash
npm install
cp .env.example .env
```

Fill `.env` with your deployed StockWallet address, QuoterV2 address and RPC. Keep `DRY_RUN=true` first.

## Configure tokens

Edit `src/config.js` and add verified token addresses. `sellPath: '0x'` asks the contract to auto-detect the route. Only enable a token after verifying its address, its USDC pool/liquidity, the contract's stored risk config and the account's `ADGENT_ROLE`.

## Run

```bash
npm run check
npm start
```

After testing, set `DRY_RUN=false` to allow sell transactions. Do not use a key holding more funds than needed for gas. Never commit `.env`; `.gitignore` excludes it.

## Rules

For selling, the bot's off-chain quote is only a signal. The contract independently calculates the quote and enforces `stopLossBps` / `takeProfitBps`. Note that the current contract's take-profit branch sells the profit portion based on its own `_getBestPoolFee` quote.

Buy rules are represented in config planning only and are not executable until a single-token purchase function is added/confirmed in the deployed contract.


## Lectura automática de reglas on-chain

El bot consulta `assets(i)` para descubrir los tokens registrados y lee `assetConfig(token)` y `assetPosition(token)` para obtener allocation, stop-loss, take-profit e inversión acumulada. No necesitas copiar porcentajes a `config.js`. Como el contrato actual no expone `assetsLength()`, el bot intenta leer índices desde 0 hasta que el getter revierta (máximo 100 tokens).

Primera ejecución: deja `DRY_RUN=true`. El bot solo imprime condiciones detectadas; no envía transacciones. Las ventas reales requieren configurar `BOT_PRIVATE_KEY`, confirmar que esa cuenta tiene `ADGENT_ROLE` y cambiar `DRY_RUN=false`. La función `selltoken` vuelve a verificar la regla on-chain. Las compras individuales no se ejecutan: `invest(bytes[])` distribuye fondos según las asignaciones de todos los activos y no existe en el contrato actual una función de compra individual por señal de precio.
