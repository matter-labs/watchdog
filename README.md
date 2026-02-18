# ZK Stack Watchdog

[![GitHub license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/matter-labs/zksync-wallet-vue/blob/master/LICENSE-MIT)

Service for submitting periodic on-chain transactions and exporting related metrics via a Prometheus exporter. Designed to monitor and ensure the health of ZK Stack-based chains, including during periods of low activity.

---

## Table of Contents
- [Background](#background)
- [Usage](#usage)
- [Configuration](#configuration)
- [Flows](#flows)
- [License](#license)

---

## Background
Maintaining a healthy chain is critical, including during periods of low activity. This watchdog performs periodic on-chain transactions to keep the chain active allowing to distinguish between genuine inactivity and outages.

## Usage

### Prerequisites
- Node.js (see `.nvmrc` for version)
- Yarn
- Docker (optional, for containerized deployment)

### Steps

Configure `.env` file with at least following options:

```env
WALLET_KEY=0xdeadbeef  # Wallet key to use
CHAIN_RPC_URL=http://127.0.0.1:3052 # l2 json-rpc endpoint
PAYMASTER_ADDRESS=0x111C3E89Ce80e62EE88318C2804920D4c96f92bb  # if using paymaster for transactions
METRICS_PORT=8090  # Override to avoid collisions with zkstack server
CHAIN_L1_RPC_URL=http://127.0.0.1:8545
# Wanted flows
FLOW_TRANSFER_ENABLE=1
FLOW_DEPOSIT_ENABLE=1
FLOW_DEPOSIT_USER_ENABLE=1
FLOW_WITHDRAWAL_ENABLE=1
FLOW_WITHDRAWAL_FINALIZE_ENABLE=1
FLOW_PRIVIDIUM_ENABLE=1  # Only for ZKOS mode
```

Install dependencies and start
```bash
yarn install
yarn run start
```

Or, to use Docker:
```bash
docker build -t zk-stack-watchdog .
docker run --env-file .env zk-stack-watchdog
```

## Configuration

All configuration is handled via environment variables (see `.env` for examples). Main options:

- `NODE_ENV`: `production` or `dev` (default: `dev`)
- `LOG_LEVEL`: Logging verbosity
- `CHAIN_RPC_URL`: L2 JSON-RPC endpoint
- `WALLET_KEY`: Watchdog wallet key (`0x`-prefixed hex string)
- `PAYMASTER_ADDRESS`: (optional) Use paymaster for L2 transactions
- `METRICS_PORT`: Prometheus metrics port (default: `8080`)
- `CHAIN_L1_RPC_URL`: L1 JSON-RPC endpoint
- `L2_EXECUTION_TIMEOUT`: L2 transaction inclusion timeout in ms (default: 15 seconds)
- `ZKOS_MODE`: Set to `1` to work in ZKOS mode (default: `0`). Enables ZKsync OS–specific flows (transfer, deposit, withdrawal, settlement, RPC test). Prividium flow is only available in this mode.

### Flow-specific options
See below for detailed flow configuration.

## Flows

Each flow exports its status in the `watchdog_status` metric:
- `1`: Success
- `0.5`: Skipped due to gas conditions
- `0`: Failure

Failed runs may trigger retries, depending on configuration. Alerts should be set up to trigger if status is `0` for over 1–5 minutes.

### Transfer

Performs a 1 wei transaction on L2 (uses paymaster if configured).

Options:
- `FLOW_TRANSFER_ENABLE` -- set to `1` to enable
- `FLOW_TRANSFER_INTERVAL` -- interval in ms
- `FLOW_TRANSFER_EXECUTION_TIMEOUT` -- timeout of l2 transfer confirmation in ms
- `FLOW_TRANSFER_RETRY_LIMIT` -- retry limit (default to 5)
- `FLOW_TRANSFER_RETRY_INTERVAL` -- retry interval in ms (default to 5 seconds)

### Deposit

Deposits 1 wei of base token from L1 to L2. Waits for execution on L2.

Options:
- `FLOW_DEPOSIT_ENABLE` -- set to `1` to enable
- `FLOW_DEPOSIT_INTERVAL` -- interval in ms
- `FLOW_DEPOSIT_RETRY_INTERVAL` -- retry interval in ms (default to 5 minutes)
- `FLOW_DEPOSIT_RETRY_LIMIT` -- retry limit (default to 3)
- `FLOW_DEPOSIT_L2_TIMEOUT` -- timeout of l2 deposit confirmation in ms
- `FLOW_DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI` -- gas price limit in gwei for l1 deposit transaction. If its exceeded in **estimation** the flow will skip
- `MAX_LOGS_BLOCKS` -- max number of blocks in range of `eth_getLogs` request

### Deposit User

Observes onchain deposit transactions and performs deposit if none detected or if last failed.

Options:
- `FLOW_DEPOSIT_USER_ENABLE` -- set to `1` to enable
- `FLOW_DEPOSIT_USER_INTERVAL` -- interval in ms (frequency of quaring latest deposit)
- `FLOW_DEPOSIT_USER_TX_TRIGGER_DELAY` -- max age of user transaction to consider. If exceeded watchdog will trigger deposit transaction from watchdog wallet
- `FLOW_DEPOSIT_L2_TIMEOUT`, `MAX_LOGS_BLOCKS`, `FLOW_DEPOSIT_RETRY_INTERVAL`, `FLOW_DEPOSIT_RETRY_LIMIT`, `FLOW_DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI` shared with deposit flow

### Withdrawal

Withdraws 1 wei from L2 to L1 (does not finalize).

Options:
- `FLOW_WITHDRAWAL_ENABLE` -- set to `1` to enable
- `FLOW_WITHDRAWAL_INTERVAL` -- interval in ms
- `FLOW_WITHDRAWAL_RETRY_LIMIT` -- number of retries (defaults to 10)
- `FLOW_WITHDRAWAL_RETRY_INTERVAL` -- interval between retries in ms (defaults to 30sec)

### Withdrawal Finalize

Simulates (via `eth_gasEstimate`) finalization of latest withdrawal for L1 validation.

Options:
- `FLOW_WITHDRAWAL_FINALIZE_ENABLE` -- set to `1` to enable
- `FLOW_WITHDRAWAL_FINALIZE_INTERVAL` -- interval in ms (defaults to 15 minutes)
- `PRE_V26_BRIDGES` -- set to `1` to use pre-v26 bridge interface (`withdrawalFinalize` requiring `legacySharedBridge` called through `BridgeHub` instead of `L1Nullifier` `depositFinalized` called directly). Setting to `0` is unsupported right now.

### RPC Test

Perform a simple `eth_BlockNumber` request to check if the L2 RPC is available at all.

Options:
- `FLOW_RPC_TEST_ENABLE` -- set to `0` to disable (enabled by default)
- `FLOW_RPC_TEST_INTERVAL` -- interval in ms (defaults to 1000 ms = 1 second)

### Settlement

This flow is used to ensure timely L1 settlement.
Every second it evaluates the age of the oldest unsettled (also known as unexecuted on L1) L2 block.
This age is measured against the newest L1 block (that is, not local clock time or newest L2 block).
If it's older than `SETTLEMENT_DEADLINE` (15 minutes by default), the flow is considered failed.

Options:
- `FLOW_SETTLEMENT_ENABLE` -- set to `1` to enable 
- `SETTLEMENT_DEADLINE` -- acceptable settlement delay in ms (defaults to 1.5 hours)
- `FLOW_SETTLEMENT_INTERVAL` -- interval in ms (defaults to 1000 ms = 1 second)

### Prividium

Requests SIWE (Sign-In With Ethereum) messages from the Prividium permissions API and uses the obtained auth token for L2 RPC calls. This flow is only available for ZKOS mode chains. When enabled, all L2 RPC requests include the `Authorization: Bearer` header.

If you want a full test using prividium you have to change CHAIN_RPC_URL to Prividium API

Options:
- `FLOW_PRIVIDIUM_ENABLE` -- set to `1` to enable
- `FLOW_PRIVIDIUM_DOMAIN` -- Domain for the SIWE message (e.g., `user-panel.testnet-prividium.zksync.dev`)
- `FLOW_PRIVIDIUM_API_URL` -- Base URL of the Prividium permissions API (e.g., `https://permissions-api.testnet-prividium.zksync.dev`). The flow appends `/api/siwe-messages` and `/api/auth/login/crypto-native` automatically.
- `FLOW_PRIVIDIUM_INTERVAL` -- interval in ms (defaults to 1000 ms = 1 second)

---

## License

This project is licensed under the terms of the MIT License. See the [LICENSE](LICENSE) file for details.
