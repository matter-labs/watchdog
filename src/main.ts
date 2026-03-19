import "dotenv/config";
import { createEthersClient, createEthersSdk } from "@matterlabs/zksync-js/ethers";
import { ethers, Wallet as EthersWallet, JsonRpcProvider } from "ethers";
import express from "express";
import { collectDefaultMetrics, register } from "prom-client";
import winston from "winston";

import { SETTLEMENT_DEADLINE } from "./configs";
import { DepositFlow } from "./deposit";
import { recordWalletInfo } from "./flowMetric";
import { Mutex } from "./lock";
import { setupLogger } from "./logger";
import { PrividiumFlow } from "./prividium";
import { runSiweFlow } from "./prividiumAuth";
import { LoggingJsonRpcProvider } from "./rpcLoggingProvider";
import { RpcTestFlow } from "./rpcTest";
import { SettlementFlow } from "./settlement";
import { SimpleTxFlow } from "./transfer";
import { SEC, unwrap } from "./utils";
import { WithdrawalFlow } from "./withdrawal";
import { WithdrawalReceiptStore } from "./withdrawalBase";
import { WithdrawalFinalizeFlow } from "./withdrawalFinalize";

import type { PrividiumTokenStore } from "./prividiumAuth";
import type { EthersClient, EthersSdk } from "@matterlabs/zksync-js/ethers";
import type { JsonRpcApiProviderOptions } from "ethers";

function getProviderOptions(opts?: JsonRpcApiProviderOptions): JsonRpcApiProviderOptions {
  return {
    ...opts,
    staticNetwork: true, // avoid repeated eth_chainId calls
    cacheTimeout: -1, // disable internal caching as providers are shared between flows and caching can lead to stale data
  };
}

const main = async () => {
  setupLogger(process.env.NODE_ENV, process.env.LOG_LEVEL);
  const l2PollingInterval = +(process.env.L2_POLLING_INTERVAL ?? 100);
  const wallet = new EthersWallet(unwrap(process.env.WALLET_KEY, "WALLET_KEY"));
  const l2Provider = new LoggingJsonRpcProvider(
    wallet.address,
    unwrap(process.env.CHAIN_RPC_URL, "CHAIN_RPC_URL"),
    undefined,
    getProviderOptions({ pollingInterval: l2PollingInterval })
  );
  let enabledFlows = 0;

  // Prividium flow is only available in ZKsync OS mode
  // Should come first to initialize the auth token before any other flow makes RPC calls
  if (process.env.FLOW_PRIVIDIUM_ENABLE === "1") {
    const prividiumApiUrl = unwrap(process.env.FLOW_PRIVIDIUM_API_URL);
    const prividiumDomain = unwrap(process.env.FLOW_PRIVIDIUM_DOMAIN);
    const siweSigner = new EthersWallet(unwrap(process.env.WALLET_KEY));
    const prividiumTokenStore: PrividiumTokenStore = { token: null };

    await runSiweFlow(siweSigner, prividiumApiUrl, prividiumDomain, prividiumTokenStore);
    l2Provider.setAuthTokenGetter(() => prividiumTokenStore.token);

    // Prividium flow (refreshes auth token and records metrics)
    const prividiumIntervalMs = +(process.env.FLOW_PRIVIDIUM_INTERVAL ?? SEC);
    new PrividiumFlow(siweSigner, prividiumDomain, prividiumApiUrl, prividiumIntervalMs, prividiumTokenStore).run();
    enabledFlows++;
  }

  const l2Wallet = wallet.connect(l2Provider);
  const l2WalletLock = new Mutex();

  // Lazy initialization of L1 provider, zkSync client and SDK, as they are only needed for some flows
  let _l1Provider: JsonRpcProvider | undefined;
  const getL1Provider = () => {
    if (!_l1Provider) {
      const l1RpcUrl = unwrap(process.env.CHAIN_L1_RPC_URL, "CHAIN_L1_RPC_URL");
      _l1Provider = process.env.L1_POLLING_INTERVAL
        ? new JsonRpcProvider(
            l1RpcUrl,
            undefined,
            getProviderOptions({
              pollingInterval: +process.env.L1_POLLING_INTERVAL,
            })
          )
        : new JsonRpcProvider(l1RpcUrl, undefined, getProviderOptions());
    }
    return _l1Provider;
  };

  let _client: EthersClient | undefined;
  const getClient = async () => {
    if (!_client) {
      _client = await createEthersClient({ l1: getL1Provider(), l2: l2Provider, signer: l2Wallet });
    }
    return _client;
  };

  let _sdk: EthersSdk | undefined;
  const getSdk = async () => {
    if (!_sdk) {
      _sdk = createEthersSdk(await getClient());
    }
    return _sdk;
  };
  //

  winston.info(
    `Wallet ${l2Wallet.address} L2 balance is ${ethers.formatEther(await l2Provider.getBalance(l2Wallet.address))}`
  );
  recordWalletInfo(l2Wallet.address);

  if (process.env.FLOW_TRANSFER_ENABLE === "1") {
    new SimpleTxFlow(
      l2Wallet,
      l2WalletLock,
      l2Provider,
      +unwrap(process.env.FLOW_TRANSFER_INTERVAL, "FLOW_TRANSFER_INTERVAL")
    ).run();
    enabledFlows++;
  }

  if (process.env.FLOW_DEPOSIT_ENABLE === "1") {
    const client = await getClient();
    const sdk = await getSdk();
    const { bridgehub, l1AssetRouter } = await sdk.contracts.instances();
    const chainId = (await l2Provider.getNetwork()).chainId;
    const baseToken = await client.baseToken(chainId);
    const zkChainAddress = await bridgehub.getHyperchain(chainId);

    new DepositFlow(
      l2Wallet,
      client,
      sdk,
      l1AssetRouter,
      zkChainAddress,
      chainId,
      baseToken,
      +unwrap(process.env.FLOW_DEPOSIT_INTERVAL, "FLOW_DEPOSIT_INTERVAL")
    ).run();
    enabledFlows++;
  }

  const withdrawalReceiptStore = new WithdrawalReceiptStore();

  if (process.env.FLOW_WITHDRAWAL_ENABLE === "1") {
    new WithdrawalFlow(
      l2Wallet,
      l2WalletLock,
      +unwrap(process.env.FLOW_WITHDRAWAL_INTERVAL, "FLOW_WITHDRAWAL_INTERVAL"),
      await getSdk(),
      withdrawalReceiptStore
    ).run();
    enabledFlows++;
  }

  if (process.env.FLOW_WITHDRAWAL_FINALIZE_ENABLE === "1") {
    new WithdrawalFinalizeFlow(
      l2Wallet,
      await getClient(),
      +unwrap(process.env.FLOW_WITHDRAWAL_FINALIZE_INTERVAL, "FLOW_WITHDRAWAL_FINALIZE_INTERVAL"),
      withdrawalReceiptStore
    ).run();
    enabledFlows++;
  }

  // RPC Test flow (eth_blockNumber)
  if (process.env.FLOW_RPC_TEST_ENABLE !== "0") {
    const rpcTestIntervalMs = +(process.env.FLOW_RPC_TEST_INTERVAL ?? SEC);
    new RpcTestFlow(l2Provider, rpcTestIntervalMs).run();
    enabledFlows++;
  }

  // Settlement flow
  if (process.env.FLOW_SETTLEMENT_ENABLE === "1") {
    const settlementIntervalMs = +(process.env.FLOW_SETTLEMENT_INTERVAL ?? SEC);
    new SettlementFlow(l2Provider, getL1Provider(), settlementIntervalMs, SETTLEMENT_DEADLINE).run();
    enabledFlows++;
  }

  winston.info(`Enabled ${enabledFlows} flows`);
  if (enabledFlows === 0) {
    winston.error("No flows enabled");
    process.exit(1);
  }
};

collectDefaultMetrics();

const app = express();

app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

app.listen(+(process.env.METRICS_PORT ?? 8080), "0.0.0.0");

main().catch((err) => {
  winston.error("Fatal startup error", err);
  process.exit(1);
});
