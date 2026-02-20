import "dotenv/config";

import { Gauge } from "prom-client";

import { BaseFlow } from "./baseFlow";
import { SEC, timeoutPromise } from "./utils";

import type { Provider } from "ethers";
import type { Provider as ZkSyncProvider } from "zksync-ethers";

const FLOW_NAME = "settlement";

export class SettlementFlow extends BaseFlow {
  private metricSettlementAge: Gauge;

  constructor(
    private l2Provider: ZkSyncProvider,
    private l1Provider: Provider,
    private intervalMs: number,
    private settlementDeadline: number
  ) {
    super(FLOW_NAME);
    this.metricSettlementAge = new Gauge({
      name: "watchdog_settlement_age",
      help: "Age of the oldest unsettled block in seconds (0 if no unsettled blocks)",
    });
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      try {
        this.metricRecorder.recordFlowStart();

        let settlementAgeSec = 0;

        await this.metricRecorder.stepExecution({
          stepName: "settlement",
          stepTimeoutMs: 2 * SEC,
          fn: async () => {
            // Get the last settled block on L2
            const lastSettledBlock = await this.l2Provider.getBlock("finalized");
            if (!lastSettledBlock) {
              throw new Error("Failed to get last settled block");
            }

            this.logger.debug(`Last settled block number: ${lastSettledBlock.number}`);

            // Check if there's a first unsettled block (settled + 1)
            const firstUnsettledBlock = await this.l2Provider.getBlock(lastSettledBlock.number + 1);

            if (firstUnsettledBlock) {
              // There is an unsettled block
              this.logger.debug(
                `Found unsettled block ${firstUnsettledBlock.number} with timestamp ${firstUnsettledBlock.timestamp}`
              );

              // Get the latest L1 block
              const l1Block = await this.l1Provider.getBlock("latest");
              if (!l1Block) {
                throw new Error("Failed to get L1 block");
              }

              this.logger.debug(`L1 latest block timestamp: ${l1Block.timestamp}`);

              // Calculate the settlement age
              settlementAgeSec = l1Block.timestamp - firstUnsettledBlock.timestamp;
              this.logger.debug(`Settlement age: ${settlementAgeSec} seconds`);

              // Record the metric
              this.metricSettlementAge.set(settlementAgeSec);

              // Check if it exceeds the deadline
              if (settlementAgeSec * SEC > this.settlementDeadline) {
                throw new Error(
                  `Settlement age ${settlementAgeSec}s exceeds deadline ${this.settlementDeadline / 1000}s`
                );
              }
            } else {
              // No unsettled blocks
              this.logger.debug("No unsettled blocks found");
              this.metricSettlementAge.set(0);
            }
          },
        });

        this.metricRecorder.recordFlowSuccess();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        this.logger.error("Settlement check error: " + error?.message, error?.stack);
        this.metricRecorder.recordFlowFailure();
      }

      await nextExecutionWait;
    }
  }
}
