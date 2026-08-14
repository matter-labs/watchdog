import "dotenv/config";
import { BaseFlow } from "./baseFlow";
import { L2_BALANCE_TIMEOUT, L2_EXECUTION_TIMEOUT } from "./configs";
import { recordL2BaseTokenBalance, StatusNoSkip } from "./flowMetric";
import { SEC, timeoutPromise, unwrap } from "./utils";

import type { Mutex } from "./lock";
import type { WatchdogSigner } from "./wallet";
import type { Provider, TransactionRequest } from "ethers";

const FLOW_NAME = "transfer";

export class SimpleTxFlow extends BaseFlow {
  constructor(
    private wallet: WatchdogSigner,
    private l2WalletLock: Mutex,
    private provider: Provider,
    intervalMs: number
  ) {
    super(FLOW_NAME, intervalMs);
  }

  protected getTxRequest(): TransactionRequest {
    return {
      to: this.wallet.address,
      value: 1, // just 1 wei
    };
  }

  protected async step(): Promise<StatusNoSkip> {
    try {
      this.metricRecorder.recordFlowStart();

      // Record L2 balance before each cycle
      const l2Balance = await this.metricRecorder.stepExecution({
        stepName: "balance",
        stepTimeoutMs: L2_BALANCE_TIMEOUT,
        fn: () => this.provider.getBalance(this.wallet.address),
      });
      recordL2BaseTokenBalance(l2Balance);

      // populate transaction
      const tx = this.getTxRequest();
      const populated = await this.metricRecorder.stepExecution({
        stepName: "estimation",
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const latestNonce = await this.wallet.getNonce("latest");
          const populated = await this.wallet.populateTransaction({
            ...tx,
            nonce: latestNonce,
          });
          const gasPrice = unwrap(populated.maxFeePerGas ?? populated.gasPrice, "populated transaction gas price");
          const gasLimit = unwrap(populated.gasLimit, "populated transaction gas limit");
          recordStepGasPrice(gasPrice);
          recordStepGas(gasLimit);
          recordStepGasCost(BigInt(gasLimit) * BigInt(gasPrice));
          return populated;
        },
      });

      // send transaction
      const txResponse = await this.metricRecorder.stepExecution({
        stepName: "send",
        stepTimeoutMs: 10 * SEC,
        fn: () => this.wallet.sendTransaction(populated),
      });

      // wait for transaction
      await this.metricRecorder.stepExecution({
        stepName: "execution",
        stepTimeoutMs: L2_EXECUTION_TIMEOUT,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const receipt = unwrap(await this.provider.waitForTransaction(txResponse.hash, 1), "transaction receipt");
          const gasUsed = unwrap(receipt.gasUsed, "transaction receipt gas used");
          const gasPrice = unwrap(receipt.gasPrice, "transaction receipt gas price");
          recordStepGas(gasUsed);
          recordStepGasPrice(gasPrice);
          recordStepGasCost(BigInt(gasUsed) * BigInt(gasPrice));
          return receipt;
        },
      });

      this.metricRecorder.recordFlowSuccess();
      return StatusNoSkip.OK;
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.logger.error("simple tx error:", normalizedError);
      this.metricRecorder.recordFlowFailure();
      return StatusNoSkip.FAIL;
    }
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      await this.l2WalletLock.withLock(() => this.step());
      await nextExecutionWait;
    }
  }
}
