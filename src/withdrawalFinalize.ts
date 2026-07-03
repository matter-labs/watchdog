import "dotenv/config";

import { createFinalizationServices } from "@matterlabs/zksync-js/ethers";
import { Gauge } from "prom-client";

import { Status } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";
import { WithdrawalBaseFlow, STEPS } from "./withdrawalBase";

import type { WatchdogSigner } from "./wallet";
import type { ExecutionResultKnown, WithdrawalReceiptStore } from "./withdrawalBase";
import type { FinalizeDepositParams, ZKsyncError } from "@matterlabs/zksync-js/core";
import type { EthersClient } from "@matterlabs/zksync-js/ethers";

const FLOW_NAME = "withdrawalFinalize";
const FINALIZE_INTERVAL = +(process.env.FLOW_WITHDRAWAL_FINALIZE_INTERVAL ?? 15 * MIN);

// the SDK doesn't export ZKsyncError as a value, so check the error envelope structurally
function isProofNotAvailableError(e: ZKsyncError): boolean {
  return (
    e?.envelope?.operation === "zksrpc.getL2ToL1LogProof" &&
    e?.envelope?.message?.toLowerCase().includes("proof not yet available")
  );
}

export class WithdrawalFinalizeFlow extends WithdrawalBaseFlow {
  private metricTimeSinceLastFinalizableWithdrawal: Gauge;
  private metricTimeSinceLastFinalizedBlock: Gauge;
  private finalizationService;

  constructor(
    wallet: WatchdogSigner,
    private client: EthersClient,
    intervalMs: number = FINALIZE_INTERVAL,
    private receiptStore: WithdrawalReceiptStore
  ) {
    super(wallet, FLOW_NAME, intervalMs);
    this.finalizationService = createFinalizationServices(this.client);
    this.metricTimeSinceLastFinalizableWithdrawal = new Gauge({
      name: "watchdog_time_since_last_finalizable_withdrawal",
      help: "Blockchain second since last finalizable withdrawal transaction on L2",
    });
    this.metricTimeSinceLastFinalizedBlock = new Gauge({
      name: "watchdog_time_since_last_finalized_block",
      help: "Real second since last finalized block on L2",
    });
  }
  protected async executeWithdrawalFinalize(): Promise<Status> {
    try {
      const blockTimestamp = await this.getCurrentChainTimestamp();
      const finalizedBlock = await this.wallet.provider!.getBlock("finalized");
      this.metricRecorder.recordFlowStart();

      const candidates = this.receiptStore.getFinalizeCandidates(finalizedBlock?.number);
      if (candidates.length === 0) {
        const lastExecution = await this.getLastExecution("finalized", this.wallet.address);
        if (lastExecution) candidates.push(lastExecution);
      }

      if (candidates.length === 0) {
        this.logger.warn("No withdrawal found to try finalize");
        this.metricRecorder.recordFlowSkipped();
        return Status.SKIP;
      }

      this.metricTimeSinceLastFinalizedBlock.set(new Date().getTime() / 1000 - finalizedBlock!.timestamp);

      const finalizable = await this.metricRecorder.stepExecution({
        stepName: STEPS.get_finalization_params,
        stepTimeoutMs: 10 * SEC * candidates.length,
        fn: () => this.findFinalizableWithdrawal(candidates),
      });

      if (!finalizable) {
        this.logger.warn(`None of the ${candidates.length} withdrawal(s) in finalized blocks is finalizable yet`);
        this.metricRecorder.recordFlowSkipped();
        return Status.SKIP;
      }
      const { execution, params } = finalizable;
      const withdrawalHash = execution.l2Receipt.hash;

      this.metricTimeSinceLastFinalizableWithdrawal.set(blockTimestamp - execution.timestampL2);

      this.logger.info(`Simulating finalization for withdrawal hash: ${withdrawalHash}`);

      // Instead of sending a transaction, just estimate and record the gas for finalization
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l1_simulation,
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas }) => {
          const estimate = await this.finalizationService.estimateFinalization(params);
          recordStepGas(estimate.gasLimit);
        },
      });

      this.logger.info(`Finalization simulation for withdrawal ${withdrawalHash} successful`);

      this.metricRecorder.recordFlowSuccess();
      return Status.OK;
    } catch (e) {
      this.logger.error(`Error during flow execution: ${unwrap(e)}`);
      this.metricRecorder.recordFlowFailure();
      return Status.FAIL;
    }
  }

  /// Returns the first candidate (and its finalization params) that can actually be finalized on L1 right now.
  private async findFinalizableWithdrawal(
    candidates: ExecutionResultKnown[]
  ): Promise<{ execution: ExecutionResultKnown; params: FinalizeDepositParams } | null> {
    for (const execution of candidates) {
      const withdrawalHash = execution.l2Receipt.hash;

      let params: FinalizeDepositParams;
      try {
        ({ params } = await this.finalizationService.fetchFinalizeDepositParams(withdrawalHash as `0x${string}`));
      } catch (e) {
        if (!isProofNotAvailableError(e as ZKsyncError)) throw e;
        this.logger.info(`No finalization params for withdrawal ${withdrawalHash} yet: ${unwrap(e)}`);
        continue;
      }

      const readiness = await this.finalizationService.simulateFinalizeReadiness(params);
      switch (readiness.kind) {
        case "READY":
          return { execution, params };
        case "FINALIZED":
          this.logger.info(`Withdrawal ${withdrawalHash} is already finalized, trying an older one`);
          break;
        case "NOT_READY":
          this.logger.info(`Withdrawal ${withdrawalHash} is not finalizable yet: ${readiness.reason}`);
          break;
        case "UNFINALIZABLE":
          this.logger.warn(`Withdrawal ${withdrawalHash} can never be finalized: ${readiness.reason}`);
          break;
      }
    }
    return null;
  }

  public async run() {
    this.logger.info(`Starting withdrawal finalize flow with interval ${this.intervalMs / MIN} minutes`);
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      await this.executeWithdrawalFinalize();
      await nextExecutionWait;
    }
  }
}
