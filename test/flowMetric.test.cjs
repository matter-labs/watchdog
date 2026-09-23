const assert = require("node:assert/strict");
const { test } = require("node:test");
const { register } = require("prom-client");
const { FlowMetricRecorder } = require("../src/flowMetric");
const { timeoutPromise } = require("../src/utils");

const logger = { info: () => {}, error: () => {} };

// The registry is process-global, so compare against a snapshot taken before the runs.
const count = async (outcome) =>
  (await register.getSingleMetric("watchdog_step_duration_seconds").get()).values.find(
    (v) => v.metricName.endsWith("_count") && v.labels.flow === "t" && v.labels.outcome === outcome
  )?.value ?? 0;

const runStep = async (stepTimeoutMs, fn) => {
  const recorder = new FlowMetricRecorder("t", logger);
  recorder.recordFlowStart();
  await assert.rejects(() => recorder.stepExecution({ stepName: "step", stepTimeoutMs, fn }));
};

test("a step that exceeds its budget is a timeout, a step that throws is an error", async () => {
  const before = { timeout: await count("timeout"), error: await count("error") };

  await runStep(10, () => timeoutPromise(50));
  await runStep(1000, async () => {
    throw new Error("boom");
  });

  assert.equal(await count("timeout"), before.timeout + 1);
  assert.equal(await count("error"), before.error + 1);
});
