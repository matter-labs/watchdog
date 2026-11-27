import "dotenv/config";
import { L2_NATIVE_TOKEN_VAULT_ADDRESS } from "@matterlabs/zksync-js/core";
import { getAddress, id, zeroPadValue } from "ethers";

import { BaseFlow } from "./baseFlow";
import { SEC, unwrap } from "./utils";

import type { WatchdogSigner } from "./wallet";
import type { TransactionReceipt } from "ethers";

export type ExecutionResultUnknown = null;
export type ExecutionResultKnown = {
  l2Receipt: TransactionReceipt;
  timestampL2: number;
};
export type ExecutionResult = ExecutionResultUnknown | ExecutionResultKnown;

// number of stored withdrawal receipts that are used in the finalization flow to check if there are any finalizable
// withdrawals. A withdrawal becomes finalizable only once its batch is executed on L1, which takes hours on mainnets,
// so the store has to span that lag: 100 receipts are over 8 hours at a 5-minute withdrawal interval.
const WITHDRAWAL_RECEIPT_STORE_SIZE = 100;

export class WithdrawalReceiptStore {
  private entries: ExecutionResultKnown[] = [];

  add(l2Receipt: TransactionReceipt, timestampL2: number): void {
    this.entries.push({ l2Receipt, timestampL2 });
    if (this.entries.length > WITHDRAWAL_RECEIPT_STORE_SIZE) {
      this.entries.shift();
    }
  }

  /// Returns stored withdrawals that are in finalized blocks, newest first. Block finality alone doesn't
  /// guarantee a withdrawal is finalizable (its proof may not be available yet), so callers should pick
  /// the first candidate that passes an on-chain readiness check.
  getFinalizeCandidates(finalizedBlockNumber: number | null | undefined): ExecutionResultKnown[] {
    if (finalizedBlockNumber == null) return [];
    return this.entries.filter((entry) => entry.l2Receipt.blockNumber <= finalizedBlockNumber).reverse();
  }
}

export const STEPS = {
  estimation: "estimation",
  send: "send",
  l2_execution: "l2_execution",
  find_candidates: "find_candidates",
  get_finalization_params: "get_finalization_params",
  l1_simulation: "l1_simulation",
};

export const WITHDRAWAL_RETRY_INTERVAL = +(process.env.FLOW_WITHDRAWAL_RETRY_INTERVAL ?? 30 * SEC);
export const WITHDRAWAL_RETRY_LIMIT = +(process.env.FLOW_WITHDRAWAL_RETRY_LIMIT ?? 10);

// Since protocol v32 a withdrawal goes through the InteropCenter, and the only event that indexes its sender is the
// native token vault's BridgeBurn (chainId, assetId, sender are indexed).
const BRIDGE_BURN_TOPIC = id("BridgeBurn(uint256,bytes32,address,address,uint256)");
// The RPC rejects eth_getLogs ranges wider than 10000 blocks.
const MAX_LOGS_BLOCKS_L2_CAP = 10_000;

export abstract class WithdrawalBaseFlow extends BaseFlow {
  constructor(
    protected wallet: WatchdogSigner,
    flowName: string,
    intervalMs: number
  ) {
    super(flowName, intervalMs);
  }

  /// Finds the wallet's newest withdrawal in the last `MAX_LOGS_BLOCKS_L2` blocks up to `blockType`.
  /// `MAX_LOGS_BLOCKS_L2=0` turns the lookup off.
  protected async getLastExecution(blockType: "latest" | "finalized", wallet: string): Promise<ExecutionResult> {
    const maxBlocks = Math.min(+(process.env.MAX_LOGS_BLOCKS_L2 ?? 1000), MAX_LOGS_BLOCKS_L2_CAP);
    if (maxBlocks === 0) return null;
    const topBlock = await this.wallet.provider!.getBlock(blockType);
    const topBlockNumber = topBlock!.number;

    const events = await this.wallet.provider!.getLogs({
      address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
      topics: [BRIDGE_BURN_TOPIC, null, null, zeroPadValue(getAddress(wallet), 32)],
      fromBlock: Math.max(0, topBlockNumber - maxBlocks),
      toBlock: topBlockNumber,
    });

    events.sort((a, b) => b.blockNumber - a.blockNumber);

    if (events.length === 0) return null;

    const event = events[0];
    const timestampL2 = (await event.getBlock()).timestamp;
    const l2Receipt = await event.getTransactionReceipt();

    return {
      l2Receipt,
      timestampL2,
    };
  }

  protected async getCurrentChainTimestamp(): Promise<number> {
    return unwrap(await this.wallet.provider!.getBlock("latest").then((block) => block?.timestamp));
  }
}
