import "dotenv/config";

import { ETH_ADDRESS } from "@matterlabs/zksync-js/core";
import { getL2TransactionHashFromLogs } from "@matterlabs/zksync-js/ethers";
import { formatEther, MaxInt256, parseEther } from "ethers";

import {
  DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI,
  DEPOSIT_RETRY_INTERVAL,
  DEPOSIT_RETRY_LIMIT,
  DepositBaseFlow,
  PRIORITY_OP_TIMEOUT,
  STEPS,
  getErc20Contract,
} from "./depositBase";
import { recordL1Balances, Status } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";

import type { DepositParams } from "@matterlabs/zksync-js/core";
import type { EthersClient, EthersSdk } from "@matterlabs/zksync-js/ethers";
import type { Wallet, Contract } from "ethers";

const FLOW_NAME = "deposit";

export class DepositFlow extends DepositBaseFlow {
  constructor(
    wallet: Wallet,
    client: EthersClient,
    private sdk: EthersSdk,
    sharedBridge: Contract,
    zkChainAddress: string,
    chainId: bigint,
    private baseToken: string,
    private intervalMs: number
  ) {
    super(wallet, client, sharedBridge, zkChainAddress, chainId, FLOW_NAME);
  }

  protected async executeWatchdogDeposit(): Promise<Status> {
    try {
      // even before flow start we check base token allowance and perform an unlimited approval if needed
      if (this.baseToken != ETH_ADDRESS) {
        const bridgeAddress = await this.sharedBridge.getAddress();
        const erc20Contract = getErc20Contract(this.baseToken, this.client.l1, this.wallet);
        const allowance = await erc20Contract.allowance(this.wallet.address, bridgeAddress);

        // heuristic condition to determine if we should perform the infinite approval
        if (allowance < parseEther("100000")) {
          this.logger.info(`Approving base token ${this.baseToken} for infinite amount`);
          await erc20Contract.approve(bridgeAddress, MaxInt256);
        } else {
          this.logger.info(`Base token ${this.baseToken} already has approval`);
        }
        const baseTokenBalance = await erc20Contract.balanceOf(this.wallet.address);
        const l1EthBalance = await this.client.l1.getBalance(this.wallet.address);
        this.logger.info(
          `L1 balance: Base token (${this.baseToken}) ${formatEther(baseTokenBalance.toString())}; ETH: ${formatEther(l1EthBalance.toString())}`
        );
        recordL1Balances(baseTokenBalance, l1EthBalance);
      }

      this.metricRecorder.recordFlowStart();

      const deposit = await this.metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 30 * SEC,
        fn: async ({ recordStepGas, recordStepGasCost, recordStepGasPrice }) => {
          const params = {
            to: this.wallet.address,
            token: this.baseToken,
            amount: 1n, // just 1 wei
            refundRecipient: this.wallet.address,
            l1TxOverrides: { nonce: "latest" },
          } as DepositParams;
          const depositQuote = await this.sdk.deposits.quote(params);
          recordStepGas(depositQuote.fees.l1!.gasLimit);
          recordStepGasPrice(depositQuote.fees.l1!.maxFeePerGas);
          recordStepGasCost(depositQuote.fees.l1!.maxTotal);

          return { params, quote: depositQuote };
        },
      });
      // record l2 estimates using the manual record function
      this.metricRecorder.manualRecordStepGas(STEPS.l2_estimation, unwrap(deposit.quote.fees.l2!.gasLimit));
      this.metricRecorder.manualRecordStepGasCost(STEPS.l2_estimation, unwrap(deposit.quote.fees.l2!.total));
      if (deposit.quote.fees.l1!.maxFeePerGas > DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI) {
        this.logger.warn(
          `Gas price ${deposit.quote.fees.l1!.maxFeePerGas} is higher than limit ${DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI}. Skipping deposit`
        );
        this.metricRecorder.recordFlowSkipped();
        return Status.SKIP;
      }

      // send L1 deposit transaction
      const depositHandle = await this.metricRecorder.stepExecution({
        stepName: STEPS.send,
        stepTimeoutMs: 30 * SEC,
        fn: () => this.sdk.deposits.create(deposit.params),
      });
      this.logger.info(`Tx (L1: ${depositHandle.l1TxHash}) sent on L1`);

      // wait for transaction
      const l1Tx = await this.metricRecorder.stepExecution({
        stepName: STEPS.l1_execution,
        stepTimeoutMs: 3 * MIN,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const txReceipt = await this.sdk.deposits.wait(depositHandle, { for: "l1" });
          recordStepGas(unwrap(txReceipt?.gasUsed));
          recordStepGasPrice(unwrap(txReceipt?.gasPrice));
          recordStepGasCost(unwrap(txReceipt?.gasUsed) * unwrap(txReceipt?.gasPrice));
          return txReceipt;
        },
      }); // included in a block on L1

      const l2TxHash = getL2TransactionHashFromLogs(l1Tx!.logs);
      const txHashes = `(L1: ${l1Tx?.hash}, L2: ${l2TxHash})`;
      this.logger.info(`Tx ${txHashes} mined on l1`);

      // wait for deposit to be finalized
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l2_execution,
        stepTimeoutMs: PRIORITY_OP_TIMEOUT,
        fn: async ({ recordStepGasPrice, recordStepGas, recordStepGasCost }) => {
          const receipt = unwrap(await this.sdk.deposits.wait(depositHandle, { for: "l2" }));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasCost(unwrap(receipt.gasUsed) * unwrap(receipt.gasPrice));
          return receipt;
        },
      });
      this.logger.info(`Tx ${txHashes} mined on L2`);
      this.metricRecorder.recordFlowSuccess();
      return Status.OK;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.logger.error("deposit tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
      return Status.FAIL;
    }
  }

  public async run() {
    const lastExecution = await this.getLastExecution(this.wallet.address);
    const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
    const timeSinceLastDepositSec = currentBlockchainTimestamp - lastExecution.timestampL1;
    if (lastExecution.status != null) this.metricRecorder.recordPreviousExecutionStatus(lastExecution.status!);
    if (timeSinceLastDepositSec < this.intervalMs / SEC) {
      const waitTime = this.intervalMs - timeSinceLastDepositSec * SEC;
      this.logger.info(`Waiting ${(waitTime / 1000).toFixed(0)} seconds before starting deposit flow`);
      await timeoutPromise(waitTime);
    }
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      let attempt: number = 1;
      while (attempt <= DEPOSIT_RETRY_LIMIT) {
        const result = await this.executeWatchdogDeposit();
        switch (result) {
          case Status.OK:
            this.logger.info(`attempt ${attempt} succeeded`);
            break;
          case Status.SKIP:
            this.logger.info(`attempt ${attempt} skipped (not counted towards limit)`);
            break;
          case Status.FAIL: {
            this.logger.warn(
              `[deposit] attempt ${attempt} of ${DEPOSIT_RETRY_LIMIT} failed` +
                (attempt < DEPOSIT_RETRY_LIMIT
                  ? `, retrying in ${(DEPOSIT_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                  : "")
            );
            attempt++;
            await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
            break;
          }
          default: {
            const _exhaustiveCheck: never = result;
            throw new Error(`Unreachable code branch: ${_exhaustiveCheck}`);
          }
        }
        if (result === Status.OK || result === Status.SKIP) break;
      }
      await nextExecutionWait;
    }
  }
}
