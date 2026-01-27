import "dotenv/config";
import { utils } from "zksync-ethers";
import { IEthToken__factory as IETHTokenFactory } from "zksync-ethers/build/typechain";
import { L2_BASE_TOKEN_ADDRESS } from "zksync-ethers/build/utils";

import { BaseFlow } from "./baseFlow";
import { SEC, unwrap } from "./utils";

import type { BigNumberish, ethers, TransactionReceipt } from "ethers";
import type { types, Wallet } from "zksync-ethers";
import type { PaymasterParams } from "zksync-ethers/build/types";

export type WithdrawalTxRequest = {
  token: types.Address;
  amount: BigNumberish;
  from?: types.Address;
  to?: types.Address;
  bridgeAddress?: types.Address;
  paymasterParams?: PaymasterParams;
  overrides?: ethers.Overrides;
};

export type ExecutionResultUnknown = null;
export type ExecutionResultKnown = {
  l2Receipt: TransactionReceipt;
  timestampL2: number;
};
export type ExecutionResult = ExecutionResultUnknown | ExecutionResultKnown;

export const STEPS = {
  estimation: "estimation",
  send: "send",
  l2_execution: "l2_execution",
  get_finalization_params: "get_finalization_params",
  l1_simulation: "l1_simulation",
};

export const WITHDRAWAL_RETRY_INTERVAL = +(process.env.FLOW_WITHDRAWAL_RETRY_INTERVAL ?? 30 * SEC);
export const WITHDRAWAL_RETRY_LIMIT = +(process.env.FLOW_WITHDRAWAL_RETRY_LIMIT ?? 10);

export abstract class WithdrawalBaseFlow extends BaseFlow {
  constructor(
    protected wallet: Wallet,
    protected paymasterAddress: string | undefined,
    protected isZKsyncOS: boolean,
    flowName: string
  ) {
    super(flowName);
  }

  protected getWithdrawalRequest(): WithdrawalTxRequest {
    const request: WithdrawalTxRequest = {
      to: this.wallet.address,
      token: L2_BASE_TOKEN_ADDRESS,
      amount: 1, // just 1 wei
    };
    if (this.isZKsyncOS) {
      request.overrides = { gasLimit: 30_000_000, type: 2 }; // to avoid zks_estimateFee call
    }

    if (this.paymasterAddress != null) {
      const paymasterParams = utils.getPaymasterParams(this.paymasterAddress, {
        type: "General",
        innerInput: new Uint8Array(),
      });
      return {
        ...request,
        paymasterParams,
      };
    } else {
      return request;
    }
  }

  protected async getLastExecution(
    blockType: "latest" | "finalized",
    wallet: string | undefined
  ): Promise<ExecutionResult> {
    // early return if we intended to disable this functionality
    if (process.env.MAX_LOGS_BLOCKS_L2 == "0") return null;
    const baseToken = IETHTokenFactory.connect(L2_BASE_TOKEN_ADDRESS, this.wallet._providerL2());
    const filter = baseToken.filters.Withdrawal(wallet, wallet);
    const topBlock = await this.wallet._providerL2().getBlock(blockType);
    const topBlockNumber = topBlock.number;

    const events = await this.wallet._providerL2().getLogs({
      address: L2_BASE_TOKEN_ADDRESS,
      topics: await filter.getTopicFilter(),
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
    return unwrap(
      await this.wallet
        ._providerL2()
        .getBlock("latest")
        .then((block) => block?.timestamp)
    );
  }

  protected async getLatestFinalizedBlockTimestamp(): Promise<number> {
    return unwrap(
      await this.wallet
        ._providerL2()
        .getBlock("finalized")
        .then((block) => block?.timestamp)
    );
  }
}
