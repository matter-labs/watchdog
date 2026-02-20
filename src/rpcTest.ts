import "dotenv/config";

import { BaseFlow } from "./baseFlow";
import { SEC, timeoutPromise } from "./utils";

import type { Provider } from "zksync-ethers";

const FLOW_NAME = "rpc_test";

export class RpcTestFlow extends BaseFlow {
  constructor(
    private provider: Provider,
    private intervalMs: number
  ) {
    super(FLOW_NAME);
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      try {
        this.metricRecorder.recordFlowStart();

        await this.metricRecorder.stepExecution({
          stepName: "get_block_number",
          stepTimeoutMs: SEC,
          fn: async () => {
            const resp = await this.provider.send("eth_blockNumber", []);
            this.logger.debug("eth_blockNumber response: " + resp);
          },
        });
        this.metricRecorder.recordFlowSuccess();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        this.logger.error("eth_blockNumber error: " + error?.message, error?.stack);
        this.metricRecorder.recordFlowFailure();
      }

      await nextExecutionWait;
    }
  }
}
