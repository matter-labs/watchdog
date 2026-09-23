const assert = require("node:assert/strict");
const { test } = require("node:test");
const { register } = require("prom-client");
const { FlowMetricRecorder, SkipReason } = require("../src/flowMetric");
const { timeoutPromise } = require("../src/utils");

const logger = { info: () => {}, error: () => {} };

const stepCount = async (flow, outcome) => {
  const { values } = await register.getSingleMetric("watchdog_step_duration_seconds").get();
  return values.find((v) => v.metricName.endsWith("_count") && v.labels.flow === flow && v.labels.outcome === outcome)
    ?.value;
};

const flowLabels = async (flow, outcome) => {
  const { values } = await register.getSingleMetric("watchdog_status_counter").get();
  return values.find((v) => v.labels.flow === flow && v.labels.outcome === outcome)?.labels;
};

const runFailingStep = async (flow, stepTimeoutMs, fn) => {
  const recorder = new FlowMetricRecorder(flow, logger);
  recorder.recordFlowStart();
  await assert.rejects(() => recorder.stepExecution({ stepName: "step", stepTimeoutMs, fn }));
};

test("a step that exceeds its budget is a timeout, not a generic error", async () => {
  await runFailingStep("t_timeout", 10, () => timeoutPromise(50));

  assert.equal(await stepCount("t_timeout", "timeout"), 1);
  assert.equal(await stepCount("t_timeout", "error"), undefined, "a timeout must not also count as an error");
});

test("a step that throws is an error, not a timeout", async () => {
  await runFailingStep("t_error", 1000, async () => {
    throw new Error("boom");
  });

  assert.equal(await stepCount("t_error", "error"), 1);
  assert.equal(await stepCount("t_error", "timeout"), undefined);
});

test("a successful step is observed once", async () => {
  const recorder = new FlowMetricRecorder("t_ok", logger);
  recorder.recordFlowStart();
  await recorder.stepExecution({ stepName: "step", stepTimeoutMs: 1000, fn: async () => "done" });

  assert.equal(await stepCount("t_ok", "ok"), 1);
});

test("a skip records why the flow did no work", async () => {
  const recorder = new FlowMetricRecorder("t_skip", logger);
  recorder.recordFlowStart();
  recorder.recordFlowSkipped(SkipReason.NOT_FINALIZABLE);

  assert.equal((await flowLabels("t_skip", "skipped")).reason, "not_finalizable");
});
