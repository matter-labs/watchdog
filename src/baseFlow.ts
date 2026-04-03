import winston from "winston";

import { FlowMetricRecorder } from "./flowMetric";
import { timeoutPromise } from "./utils";

import type { Logger } from "winston";

const TASK_INIT_RETRY_INTERVAL = +(process.env.FLOW_INIT_RETRY_INTERVAL ?? 10_000);

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

  public async run(): Promise<void> {
    // limit the retry interval to avoid too long waits in case intervalMs is large (e.g. for withdrawal flow)
    const retryInterval = Math.min(this.intervalMs, TASK_INIT_RETRY_INTERVAL);
    while (true) {
      const nextRun = timeoutPromise(this.intervalMs);
      try {
        await this.runAction();
        await nextRun;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        this.logger.error(
          `Unexpected error in flow ${this.flowName}, restarting in ${retryInterval}ms: ${error?.message}`,
          error?.stack
        );
        this.metricRecorder.recordFlowFailure();
        await timeoutPromise(retryInterval);
      }
    }
  }

  protected abstract runAction(): Promise<void>;
}
