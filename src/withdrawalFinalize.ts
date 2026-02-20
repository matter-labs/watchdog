import "dotenv/config";

import { Gauge } from "prom-client";
import { L2_BASE_TOKEN_ADDRESS, isAddressEq } from "zksync-ethers/build/utils";

import { Status } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";
import { WithdrawalBaseFlow, STEPS } from "./withdrawalBase";

import type { BigNumberish } from "ethers";
import type { Wallet } from "zksync-ethers";

const FLOW_NAME = "withdrawalFinalize";
const FINALIZE_INTERVAL = +(process.env.FLOW_WITHDRAWAL_FINALIZE_INTERVAL ?? 15 * MIN);
const PRE_V26_BRIDGES = process.env.PRE_V26_BRIDGES === "1";

export class WithdrawalFinalizeFlow extends WithdrawalBaseFlow {
  private metricTimeSinceLastFinalizableWithdrawal: Gauge;
  private metricTimeSinceLastFinalizedBlock: Gauge;

  constructor(
    wallet: Wallet,
    isZKsyncOS: boolean,
    private intervalMs: number = FINALIZE_INTERVAL
  ) {
    super(wallet, undefined, isZKsyncOS, FLOW_NAME);
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
      const execution = await this.getLastExecution("finalized", this.wallet.address);
      const blockTimestamp = await this.getCurrentChainTimestamp();
      const finalizedBlockTimestamp = await this.getLatestFinalizedBlockTimestamp();
      this.metricRecorder.recordFlowStart();

      if (!execution) {
        this.logger.warn("No withdrawal found to try finalize");
        this.metricRecorder.recordFlowSkipped();
        return Status.SKIP;
      }
      const withdrawalHash = execution.l2Receipt.hash;

      this.metricTimeSinceLastFinalizableWithdrawal.set(blockTimestamp - execution.timestampL2);
      this.metricTimeSinceLastFinalizedBlock.set(new Date().getTime() / 1000 - finalizedBlockTimestamp);

      this.logger.info(`Simulating finalization for withdrawal hash: ${withdrawalHash}`);

      // Get finalization parameters
      const { l1BatchNumber, l2MessageIndex, l2TxNumberInBlock, message, sender, proof } =
        await this.metricRecorder.stepExecution({
          stepName: STEPS.get_finalization_params,
          stepTimeoutMs: 10 * SEC,
          fn: async () => {
            return this.wallet.getFinalizeWithdrawalParams(withdrawalHash);
          },
        });

      if (!isAddressEq(sender, L2_BASE_TOKEN_ADDRESS)) {
        throw new Error(`Withdrawal ${withdrawalHash} is not a base token withdrawal`);
      }
      // Determine the correct L1 bridge

      const bridges = await this.wallet.getL1BridgeContracts();
      if (PRE_V26_BRIDGES) {
        // Instead of sending a transaction, just simulate it with a static call
        await this.metricRecorder.stepExecution({
          stepName: STEPS.l1_simulation,
          stepTimeoutMs: 10 * SEC,
          fn: async ({ recordStepGas }) => {
            const gas = await bridges.shared.finalizeWithdrawal.estimateGas(
              (await this.wallet._providerL2().getNetwork()).chainId as BigNumberish,
              l1BatchNumber as BigNumberish,
              l2MessageIndex as BigNumberish,
              l2TxNumberInBlock as BigNumberish,
              message,
              proof
            );
            recordStepGas(gas);
          },
        });
      } else {
        throw new Error("V26 bridges are not supported");
      }

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
    if (!PRE_V26_BRIDGES) {
      throw new Error("V26 bridges are not supported");
    }
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      await this.executeWithdrawalFinalize();
      await nextExecutionWait;
    }
  }
}
