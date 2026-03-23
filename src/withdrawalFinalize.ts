import "dotenv/config";

import { createFinalizationServices } from "@matterlabs/zksync-js/ethers";
import { Gauge } from "prom-client";

import { Status } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";
import { WithdrawalBaseFlow, STEPS } from "./withdrawalBase";

import type { WithdrawalReceiptStore } from "./withdrawalBase";
import type { EthersClient } from "@matterlabs/zksync-js/ethers";
import type { Wallet } from "ethers";

const FLOW_NAME = "withdrawalFinalize";
const FINALIZE_INTERVAL = +(process.env.FLOW_WITHDRAWAL_FINALIZE_INTERVAL ?? 15 * MIN);

export class WithdrawalFinalizeFlow extends WithdrawalBaseFlow {
  private metricTimeSinceLastFinalizableWithdrawal: Gauge;
  private metricTimeSinceLastFinalizedBlock: Gauge;
  private finalizationService;

  constructor(
    wallet: Wallet,
    private client: EthersClient,
    private intervalMs: number = FINALIZE_INTERVAL,
    private receiptStore: WithdrawalReceiptStore
  ) {
    super(wallet, FLOW_NAME);
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

      const execution =
        this.receiptStore.getLatestFinalized(finalizedBlock?.number) ??
        (await this.getLastExecution("finalized", this.wallet.address));

      if (!execution) {
        this.logger.warn("No withdrawal found to try finalize");
        this.metricRecorder.recordFlowSkipped();
        return Status.SKIP;
      }
      const withdrawalHash = execution.l2Receipt.hash;

      this.metricTimeSinceLastFinalizableWithdrawal.set(blockTimestamp - execution.timestampL2);
      this.metricTimeSinceLastFinalizedBlock.set(new Date().getTime() / 1000 - finalizedBlock!.timestamp);

      this.logger.info(`Simulating finalization for withdrawal hash: ${withdrawalHash}`);

      // Get finalization parameters
      const finalizationParams = await this.metricRecorder.stepExecution({
        stepName: STEPS.get_finalization_params,
        stepTimeoutMs: 10 * SEC,
        fn: async () => {
          const { params } = await this.finalizationService.fetchFinalizeDepositParams(withdrawalHash as `0x${string}`);
          return params;
        },
      });

      // Instead of sending a transaction, just estimate and record the gas for finalization
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l1_simulation,
        stepTimeoutMs: 10 * SEC,
        fn: async ({ recordStepGas }) => {
          const params = await this.finalizationService.estimateFinalization(finalizationParams);
          recordStepGas(params.gasLimit);
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

  public async run() {
    this.logger.info(`Starting withdrawal finalize flow with interval ${this.intervalMs / MIN} minutes`);
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      await this.executeWithdrawalFinalize();
      await nextExecutionWait;
    }
  }
}
