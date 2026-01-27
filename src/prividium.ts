import { BaseFlow } from "./baseFlow";
import { SEC, timeoutPromise } from "./utils";

const FLOW_NAME = "prividium";

interface SiweMessageResponse {
  nonce: string;
  msg: string;
}

export class PrividiumFlow extends BaseFlow {
  constructor(
    private address: string,
    private domain: string,
    private apiUrl: string,
    private intervalMs: number
  ) {
    super(FLOW_NAME);
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);

      try {
        this.metricRecorder.recordFlowStart();

        const response = await this.metricRecorder.stepExecution({
          stepName: "siwe_message_request",
          stepTimeoutMs: 10 * SEC,
          fn: async () => {
            const response = await fetch(this.apiUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "*/*",
              },
              body: JSON.stringify({
                address: this.address,
                domain: this.domain,
              }),
            });

            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = (await response.json()) as SiweMessageResponse;

            if (!data.nonce || !data.msg) {
              throw new Error("Response missing required fields: nonce or msg");
            }

            this.logger.debug(`SIWE message response: nonce=${data.nonce}, msg length=${data.msg.length}`);
            return data;
          },
        });

        this.logger.info(`Successfully received SIWE message: nonce=${response.nonce}`);
        this.metricRecorder.recordFlowSuccess();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        this.logger.error(`SIWE message request failed: ${error?.message || error?.toString() || "Unknown error"}`, {
          apiUrl: this.apiUrl,
          address: this.address,
          domain: this.domain,
          error: error?.stack || error,
        });
        this.metricRecorder.recordFlowFailure();
      }

      await nextExecutionWait;
    }
  }
}
