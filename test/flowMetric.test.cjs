const assert = require("node:assert/strict");
const { test } = require("node:test");
const { makeError } = require("ethers");
const { register } = require("prom-client");
const { FlowMetricRecorder } = require("../src/flowMetric");
const { timeoutPromise } = require("../src/utils");

const logger = { info: () => {}, error: () => {} };

// The registry is process-global, so compare against a snapshot taken before the run.
const count = async (flow, outcome) =>
  (await register.getSingleMetric("watchdog_step_duration_seconds").get()).values.find(
    (v) => v.metricName.endsWith("_count") && v.labels.flow === flow && v.labels.outcome === outcome
  )?.value ?? 0;

const runFailingStep = async (flow, stepTimeoutMs, fn) => {
  const recorder = new FlowMetricRecorder(flow, logger);
  recorder.recordFlowStart();
  await assert.rejects(() => recorder.stepExecution({ stepName: "step", stepTimeoutMs, fn }));
};

test("a step that exceeds its own budget is a timeout", async () => {
  const before = await count("t_budget", "timeout");
  await runFailingStep("t_budget", 10, () => timeoutPromise(50));
  assert.equal(await count("t_budget", "timeout"), before + 1);
});

test("an ethers request deadline is a timeout, not an error", async () => {
  const before = { timeout: await count("t_ethers", "timeout"), error: await count("t_ethers", "error") };

  // ethers reports its FetchRequest deadline as code TIMEOUT on an Error named "Error"
  await runFailingStep("t_ethers", 1000, async () => {
    throw makeError("timeout", "TIMEOUT", { operation: "request.send", reason: "timeout" });
  });

  assert.equal(await count("t_ethers", "timeout"), before.timeout + 1);
  assert.equal(await count("t_ethers", "error"), before.error);
});

test("a step that throws is an error, not a timeout", async () => {
  const before = { timeout: await count("t_error", "timeout"), error: await count("t_error", "error") };

  await runFailingStep("t_error", 1000, async () => {
    throw new Error("boom");
  });

  assert.equal(await count("t_error", "error"), before.error + 1);
  assert.equal(await count("t_error", "timeout"), before.timeout);
});
