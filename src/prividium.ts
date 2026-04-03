import { BaseFlow } from "./baseFlow";
import { runSiweFlow } from "./prividiumAuth";
import { SEC } from "./utils";

import type { PrividiumTokenStore } from "./prividiumAuth";
import type { Signer } from "ethers";

const FLOW_NAME = "prividium";

export class PrividiumFlow extends BaseFlow {
  constructor(
    private signer: Signer,
    private domain: string,
    private apiUrl: string,
    intervalMs: number,
    private tokenStore: PrividiumTokenStore
  ) {
    super(FLOW_NAME, intervalMs);
  }

  protected async runAction(): Promise<void> {
    try {
      this.metricRecorder.recordFlowStart();

      await this.metricRecorder.stepExecution({
        stepName: "siwe_full_flow",
        stepTimeoutMs: 10 * SEC,
        fn: async () => {
          await runSiweFlow(this.signer, this.apiUrl, this.domain, this.tokenStore);
        },
      });

      this.logger.info("Prividium SIWE flow completed; token refreshed");
      this.metricRecorder.recordFlowSuccess();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.logger.error(`Prividium SIWE flow failed: ${error?.message || error?.toString() || "Unknown error"}`, {
        apiUrl: this.apiUrl,
        domain: this.domain,
        error: error?.stack || error,
      });
      throw error;
    }
  }
}
