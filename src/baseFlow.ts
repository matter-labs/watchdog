import winston from "winston";

import { FlowMetricRecorder } from "./flowMetric";

import type { Logger } from "winston";

/**
 * Base class for all flows that provides common logging functionality
 */
export abstract class BaseFlow {
  protected logger: Logger;
  protected metricRecorder: FlowMetricRecorder;

  constructor(flowName: string) {
    this.logger = winston.child({ flowName });
    this.metricRecorder = new FlowMetricRecorder(flowName, this.logger);
  }
}
