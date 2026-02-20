import "dotenv/config";

import { ETH_ADDRESS } from "@matterlabs/zksync-js/core";

import { L2_EXECUTION_TIMEOUT } from "./configs";
import { StatusNoSkip } from "./flowMetric";
import { SEC, unwrap, timeoutPromise } from "./utils";
import { WITHDRAWAL_RETRY_INTERVAL, WITHDRAWAL_RETRY_LIMIT, WithdrawalBaseFlow, STEPS } from "./withdrawalBase";

import type { Mutex } from "./lock";
import type { WithdrawParams } from "@matterlabs/zksync-js/core";
import type { EthersSdk } from "@matterlabs/zksync-js/ethers/sdk";
import type { Wallet } from "ethers";

const FLOW_NAME = "withdrawal";

export class WithdrawalFlow extends WithdrawalBaseFlow {
  constructor(
    wallet: Wallet,
    private l2WalletLock: Mutex,
    private intervalMs: number,
    private sdk: EthersSdk
  ) {
    super(wallet, FLOW_NAME);
  }

  protected async executeWatchdogWithdrawal(): Promise<StatusNoSkip> {
    try {
      this.metricRecorder.recordFlowStart();
      const withdrawalParams = await this.metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const params = {
            to: this.wallet.address,
            token: ETH_ADDRESS,
            amount: 1n, // just 1 wei
            l2TxOverrides: { nonce: "latest" },
          } as WithdrawParams;
          const withdrawalQuote = await this.sdk.withdrawals.quote(params);

          recordStepGas(unwrap(withdrawalQuote.fees.l2!.gasLimit));
          recordStepGasPrice(unwrap(withdrawalQuote.fees.l2!.maxFeePerGas));
          recordStepGasCost(
            BigInt(unwrap(withdrawalQuote.fees.l2!.gasLimit)) * BigInt(unwrap(withdrawalQuote.fees.l2!.maxFeePerGas))
          );

          return params;
        },
      });
      // send L2 withdrawal transaction
      const withdrawalHandle = await this.metricRecorder.stepExecution({
        stepName: STEPS.send,
        stepTimeoutMs: 10 * SEC,
        fn: () => this.sdk.withdrawals.create(withdrawalParams),
      });
      this.logger.info(`Tx (L2: ${withdrawalHandle.l2TxHash}) sent on L2`);

      // wait for transaction to be included in L2 block
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l2_execution,
        stepTimeoutMs: L2_EXECUTION_TIMEOUT,
        fn: async ({
          recordStepGas,
          recordStepGasPrice,
          recordStepGasCost,
        }: {
          recordStepGas: (gas: bigint) => void;
          recordStepGasPrice: (price: bigint) => void;
          recordStepGasCost: (cost: bigint) => void;
        }) => {
          const receipt = unwrap(await this.sdk.withdrawals.wait(withdrawalHandle, { for: "l2" }));
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGasCost(BigInt(unwrap(receipt.gasUsed)) * BigInt(unwrap(receipt.gasPrice)));
        },
      });

      this.logger.info(`Tx (L2: ${withdrawalHandle.l2TxHash}) included in L2 block`);
      this.metricRecorder.recordFlowSuccess();
      return StatusNoSkip.OK;
    } catch (e) {
      this.logger.error(`Error during flow execution: ${unwrap(e)}`);
      this.metricRecorder.recordFlowFailure();
      return StatusNoSkip.FAIL;
    }
  }

  public async run() {
    const lastExecution = await this.getLastExecution("latest", this.wallet.address);
    const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
    const timeSinceLastWithdrawalSec = currentBlockchainTimestamp - (lastExecution?.timestampL2 ?? 0);
    if (lastExecution != null) {
      this.metricRecorder.recordPreviousExecutionStatus(
        lastExecution.l2Receipt.status === 1 ? StatusNoSkip.OK : StatusNoSkip.FAIL
      );
    }
    if (timeSinceLastWithdrawalSec < this.intervalMs / SEC) {
      const waitTime = this.intervalMs - timeSinceLastWithdrawalSec * SEC;
      this.logger.info(`Waiting ${(waitTime / 1000).toFixed(0)} seconds before starting withdrawal flow`);
      await timeoutPromise(waitTime);
    }
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      for (let i = 0; i < WITHDRAWAL_RETRY_LIMIT; i++) {
        const result = await this.l2WalletLock.withLock(() => this.executeWatchdogWithdrawal());
        if (result === StatusNoSkip.FAIL) {
          this.logger.warn(
            `attempt ${i + 1} of ${WITHDRAWAL_RETRY_LIMIT} failed` +
              (i + 1 != WITHDRAWAL_RETRY_LIMIT
                ? `, retrying in ${(WITHDRAWAL_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                : "")
          );
          await timeoutPromise(WITHDRAWAL_RETRY_INTERVAL);
        } else {
          this.logger.info(`attempt ${i + 1} succeeded`);
          break;
        }
      }
      await nextExecutionWait;
    }
  }
}
