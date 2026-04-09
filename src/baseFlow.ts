import winston from "winston";

import { FlowMetricRecorder } from "./flowMetric";
import { timeoutPromise } from "./utils";

import type { Logger } from "winston";

const FLOW_CRASH_RESTART_INTERVAL = +(process.env.FLOW_CRASH_RESTART_INTERVAL ?? 10_000);

/**
 * Base class for all flows that provides common logging functionality
 */
export abstract class BaseFlow {
  protected logger: Logger;
  protected metricRecorder: FlowMetricRecorder;

  constructor(
    protected flowName: string,
    protected intervalMs: number
  ) {
    this.logger = winston.child({ flowName });
    this.metricRecorder = new FlowMetricRecorder(flowName, this.logger);
  }

  /**
   * Runs the flow indefinitely, restarting after a delay if an error occurs.
   * The restart interval is limited to FLOW_CRASH_RESTART_INTERVAL to avoid long waits
   * when intervalMs is large (e.g. for the withdrawal flow).
   */
  public async runWithRestart(): Promise<void> {
    // limit the retry interval to avoid too long waits in case intervalMs is large (e.g. for withdrawal flow)
    const retryInterval = Math.min(this.intervalMs, FLOW_CRASH_RESTART_INTERVAL);
    while (true) {
      try {
        await this.run();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        this.logger.error(
          `Unexpected error in flow ${this.flowName}, restarting in ${retryInterval}ms: ${error?.message}`,
          error?.stack
        );
        this.metricRecorder.recordFlowFailure();
      }
      await timeoutPromise(retryInterval);
    }
  }

  protected abstract run(): Promise<void>;
}
