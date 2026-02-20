import "dotenv/config";
import { id } from "ethers";
import { utils } from "zksync-ethers";

import { BaseFlow } from "./baseFlow";
import { StatusNoSkip } from "./flowMetric";
import { MIN, SEC, unwrap } from "./utils";

import type { BigNumberish, BytesLike, Overrides, TransactionReceipt, Provider as EthersProvider } from "ethers";
import type { types, Wallet } from "zksync-ethers";
import type { IL1SharedBridge } from "zksync-ethers/build/typechain";

type DepositTxRequest = {
  token: types.Address;
  amount: BigNumberish;
  to?: types.Address;
  operatorTip?: BigNumberish;
  bridgeAddress?: types.Address;
  approveERC20?: boolean;
  approveBaseERC20?: boolean;
  l2GasLimit?: BigNumberish;
  gasPerPubdataByte?: BigNumberish;
  refundRecipient?: types.Address;
  overrides?: Overrides;
  approveOverrides?: Overrides;
  approveBaseOverrides?: Overrides;
  customBridgeData?: BytesLike;
};

export type ExecutionResultUnknown = { status: null; timestampL1: 0 };
export type ExecutionResultKnown = {
  secSinceL1Deposit: number;
  l1Receipt: TransactionReceipt;
  timestampL1: number;
  l2Receipt?: TransactionReceipt;
  timestampL2?: number;
  status: StatusNoSkip;
};
export type ExecutionResult = ExecutionResultUnknown | ExecutionResultKnown;

export const STEPS = {
  estimation: "estimation",
  send: "send",
  l1_execution: "l1_execution",
  l2_estimation: "l2_estimation", //dummy step, no actual execution time reported
  l2_execution: "l2_execution",
};

export const PRIORITY_OP_TIMEOUT = +(process.env.FLOW_DEPOSIT_L2_TIMEOUT ?? 15 * MIN);
export const DEPOSIT_RETRY_INTERVAL = +(process.env.FLOW_DEPOSIT_RETRY_INTERVAL ?? 30 * SEC);
export const DEPOSIT_RETRY_LIMIT = +(process.env.FLOW_DEPOSIT_RETRY_LIMIT ?? 3);

const GWEI = 1000n * 1000n * 1000n;
/// We avoid L1 transactions if gas price is higher than this limit
export const DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI =
  BigInt(+(process.env.FLOW_DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI ?? 1000)) * GWEI;

export abstract class DepositBaseFlow extends BaseFlow {
  constructor(
    protected wallet: Wallet,
    protected sharedBridge: IL1SharedBridge,
    protected zkChainAddress: string,
    protected chainId: bigint,
    protected baseToken: string,
    protected l2EthersProvider: EthersProvider,
    protected isZKsyncOS: boolean,
    flowName: string
  ) {
    super(flowName);
  }

  protected getDepositRequest(): DepositTxRequest {
    const request: DepositTxRequest = {
      to: this.wallet.address,
      token: this.baseToken,
      amount: 1, // just 1 wei
      refundRecipient: this.wallet.address,
    };
    if (this.isZKsyncOS) {
      request.l2GasLimit = 1_000_000; // to avoid zks_estimateL1ToL1Gas call
    }
    return request;
  }

  protected async getLastExecution(wallet: string | undefined): Promise<ExecutionResult> {
    // works only up to v25 due to event signature change
    const filter = this.sharedBridge.filters.BridgehubDepositBaseTokenInitiated(this.chainId, wallet);
    const topicFilter = await filter.getTopicFilter();
    // also accept the new signature
    topicFilter[0] = [
      topicFilter[0] as string,
      id("BridgehubDepositBaseTokenInitiated(uint256,address,bytes32,uint256)"),
    ];
    const topBlock = await this.wallet._providerL1().getBlockNumber();
    const blockchainTime = await this.getCurrentChainTimestamp();
    // actually filter structure got modified itself so we could use it, but lets not rely on such unexpected behaviour
    const events = await this.wallet._providerL1().getLogs({
      address: await this.sharedBridge.getAddress(),
      topics: topicFilter,
      fromBlock: Math.max(topBlock - +(process.env.MAX_LOGS_BLOCKS ?? 50 * 1000), 0),
      toBlock: topBlock,
    });
    events.sort((a, b) => b.blockNumber - a.blockNumber);
    if (events.length === 0) {
      this.logger.info(`No deposits found for ${wallet ?? "any wallet"}`);
      return {
        timestampL1: 0,
        status: null,
      };
    }
    const event = events[0];

    const timestampL1 = (await event.getBlock()).timestamp;
    const l1Receipt = await event.getTransactionReceipt();
    const l2TxHash = utils.getL2HashFromPriorityOp(l1Receipt, this.zkChainAddress);
    const secSinceL1Deposit = blockchainTime - timestampL1;
    this.logger.info(
      `Found deposit ${event.transactionHash} at ${new Date(timestampL1 * 1000).toUTCString()}, ${secSinceL1Deposit} seconds ago, expecting L2 TX hash ${l2TxHash}`
    );
    let l2Receipt: TransactionReceipt | null = null;
    try {
      l2Receipt = await this.l2EthersProvider.waitForTransaction(l2TxHash, 1, PRIORITY_OP_TIMEOUT);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      this.logger.error(`${event.transactionHash} error (${e?.message}) fetching l2 transaction: ${l2TxHash} `);
    }

    const l1Res = {
      secSinceL1Deposit,
      l1Receipt,
      timestampL1,
    };
    if (l2Receipt == null) {
      this.logger.error(`${event.transactionHash} not executed on l2: ${l2TxHash} `);
      return {
        ...l1Res,
        status: StatusNoSkip.FAIL,
      };
    } else if (l2Receipt.status != 1) {
      this.logger.error(`${event.transactionHash} failed on l2: ${l2TxHash} `);
      return {
        ...l1Res,
        status: StatusNoSkip.FAIL,
      };
    } else {
      const timestampL2 = (await l2Receipt.getBlock()).timestamp;
      this.logger.info(
        `${event.transactionHash} executed successfully on l2: ${l2TxHash} at ${new Date(timestampL2 * 1000).toUTCString()} `
      );
      return {
        ...l1Res,
        l2Receipt,
        timestampL2,
        status: StatusNoSkip.OK,
      };
    }
  }

  protected async getCurrentChainTimestamp(): Promise<number> {
    return unwrap(
      await this.wallet
        ._providerL1()
        .getBlock("latest")
        .then((block) => block?.timestamp)
    );
  }
}
