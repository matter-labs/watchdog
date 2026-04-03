import "dotenv/config";

import { BaseFlow } from "./baseFlow";
import { SEC } from "./utils";

import type { JsonRpcProvider } from "ethers";

const FLOW_NAME = "rpc_test";

export class RpcTestFlow extends BaseFlow {
  constructor(
    private provider: JsonRpcProvider,
    intervalMs: number
  ) {
    super(FLOW_NAME, intervalMs);
  }

  protected async runAction(): Promise<void> {
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
  }
}
