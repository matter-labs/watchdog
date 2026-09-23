const assert = require("node:assert/strict");
const { test } = require("node:test");
const { register } = require("prom-client");
const { FlowMetricRecorder } = require("../src/flowMetric");
const { timeoutPromise } = require("../src/utils");

const silentLogger = { info: () => {}, error: () => {}, debug: () => {}, warn: () => {} };

const sample = async (metricName, labels) => {
  const base = metricName.replace(/_count$/, "");
  const metric = (await register.getMetricsAsJSON()).find((m) => m.name === base);
  return metric?.values.find(
    (v) =>
      (v.metricName ?? base) === metricName &&
      Object.entries(labels).every(([key, value]) => v.labels[key] === value)
  );
};

const runStep = async (flow, stepName, stepTimeoutMs, fn) => {
  const recorder = new FlowMetricRecorder(flow, silentLogger);
  recorder.recordFlowStart();
  try {
    await recorder.stepExecution({ stepName, stepTimeoutMs, fn });
  } catch {
    recorder.recordFlowFailure();
  }
  return recorder;
};

test("a step that exceeds its budget is recorded as a timeout, not a generic error", async () => {
  await runStep("t_timeout", "slow", 10, () => timeoutPromise(200));

  const timedOut = await sample("watchdog_step_duration_seconds_count", { flow: "t_timeout", outcome: "timeout" });
  assert.equal(timedOut?.value, 1, "the step should be counted once under outcome=timeout");

  const asError = await sample("watchdog_step_duration_seconds_count", { flow: "t_timeout", outcome: "error" });
  assert.equal(asError, undefined, "a timeout must not also be counted as an error");

  const flowFailure = await sample("watchdog_status_counter", { flow: "t_timeout", outcome: "failure" });
  assert.equal(flowFailure?.labels.reason, "timeout", "the flow failure should carry reason=timeout");
});

test("a step that throws is recorded as an error", async () => {
  await runStep("t_error", "boom", 1000, async () => {
    throw new Error("boom");
  });

  const asError = await sample("watchdog_step_duration_seconds_count", { flow: "t_error", outcome: "error" });
  assert.equal(asError?.value, 1);

  const flowFailure = await sample("watchdog_status_counter", { flow: "t_error", outcome: "failure" });
  assert.equal(flowFailure?.labels.reason, "error");
});

test("a successful step is observed once and leaves the failure reason unset", async () => {
  const recorder = new FlowMetricRecorder("t_ok", silentLogger);
  recorder.recordFlowStart();
  await recorder.stepExecution({ stepName: "fast", stepTimeoutMs: 1000, fn: async () => "done" });
  recorder.recordFlowSuccess();

  const ok = await sample("watchdog_step_duration_seconds_count", { flow: "t_ok", outcome: "ok" });
  assert.equal(ok?.value, 1);

  const success = await sample("watchdog_status_counter", { flow: "t_ok", outcome: "success" });
  assert.equal(success?.labels.reason, "");
});
