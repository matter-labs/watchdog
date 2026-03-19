import "dotenv/config";
import { L2_BASE_TOKEN_ADDRESS } from "@matterlabs/zksync-js/core";
import { getAddress, id, zeroPadValue } from "ethers";

import { BaseFlow } from "./baseFlow";
import { SEC, unwrap } from "./utils";

import type { TransactionReceipt, Wallet } from "ethers";

export type ExecutionResultUnknown = null;
export type ExecutionResultKnown = {
  l2Receipt: TransactionReceipt;
  timestampL2: number;
};
export type ExecutionResult = ExecutionResultUnknown | ExecutionResultKnown;

const WITHDRAWAL_RECEIPT_STORE_SIZE = 10;

export class WithdrawalReceiptStore {
  private entries: ExecutionResultKnown[] = [];

  add(l2Receipt: TransactionReceipt, timestampL2: number): void {
    this.entries.push({ l2Receipt, timestampL2 });
    if (this.entries.length > WITHDRAWAL_RECEIPT_STORE_SIZE) {
      this.entries.shift();
    }
  }

  getLatestFinalized(finalizedBlockNumber: number | null): ExecutionResult {
    if (finalizedBlockNumber != null) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (this.entries[i].l2Receipt.blockNumber <= finalizedBlockNumber) {
          return this.entries[i];
        }
      }
    }
    return null;
  }
}

export const STEPS = {
  estimation: "estimation",
  send: "send",
  l2_execution: "l2_execution",
  get_finalization_params: "get_finalization_params",
  l1_simulation: "l1_simulation",
};

export const WITHDRAWAL_RETRY_INTERVAL = +(process.env.FLOW_WITHDRAWAL_RETRY_INTERVAL ?? 30 * SEC);
export const WITHDRAWAL_RETRY_LIMIT = +(process.env.FLOW_WITHDRAWAL_RETRY_LIMIT ?? 10);

function getWithdrawalLogsTopicsFilter(wallet: string | undefined) {
  const walletTopic = wallet ? zeroPadValue(getAddress(wallet), 32) : null;
  const topics = [id("Withdrawal(address,address,uint256)"), walletTopic, walletTopic];
  return topics;
}

export abstract class WithdrawalBaseFlow extends BaseFlow {
  constructor(
    protected wallet: Wallet,
    flowName: string
  ) {
    super(flowName);
  }

  protected async getLastExecution(
    blockType: "latest" | "finalized",
    wallet: string | undefined
  ): Promise<ExecutionResult> {
    // early return if we intended to disable this functionality
    if (process.env.MAX_LOGS_BLOCKS_L2 == "0") return null;
    const topBlock = await this.wallet.provider!.getBlock(blockType);
    const topBlockNumber = topBlock!.number;

    const events = await this.wallet.provider!.getLogs({
      address: L2_BASE_TOKEN_ADDRESS,
      topics: getWithdrawalLogsTopicsFilter(wallet),
      fromBlock: Math.max(0, topBlockNumber - +(process.env.MAX_LOGS_BLOCKS_L2 ?? 50 * 1000)),
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

  protected async getLatestFinalizedBlockTimestamp(): Promise<number> {
    return unwrap(await this.wallet.provider!.getBlock("finalized").then((block) => block?.timestamp));
  }
}
