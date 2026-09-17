const assert = require("node:assert/strict");
const { test } = require("node:test");
const { StatusNoSkip } = require("../src/flowMetric");
const { WithdrawalFlow } = require("../src/withdrawal");
const { WithdrawalReceiptStore } = require("../src/withdrawalBase");

const wallet = "0x0000000000000000000000000000000000000001";

function fakeSdk(name, { quoteError } = {}) {
  const calls = [];
  const sdk = {
    name,
    calls,
    withdrawals: {
      async quote() {
        calls.push("quote");
        if (quoteError) throw quoteError;
        return { fees: { l2: { gasLimit: 1n, maxFeePerGas: 1n } } };
      },
      async create() {
        calls.push("create");
        return { l2TxHash: "0xabc" };
      },
      async wait() {
        calls.push("wait");
        return { gasUsed: 1n, gasPrice: 1n, blockNumber: 1, async getBlock() { return { timestamp: 1 }; } };
      },
    },
  };
  return sdk;
}

function fakeSdkManager(sdks) {
  let index = 0;
  const resets = [];
  return {
    resets,
    get: () => sdks[index],
    reset() {
      resets.push(sdks[index].name);
      index = Math.min(index + 1, sdks.length - 1);
    },
  };
}

function setup(sdkManager) {
  const flow = new WithdrawalFlow({ address: wallet }, { withLock: (fn) => fn() }, 1, sdkManager, new WithdrawalReceiptStore());
  flow.logger = { info() {}, warn() {}, error() {} };
  flow.metricRecorder = {
    recordFlowStart() {},
    recordFlowSuccess() {},
    recordFlowFailure() {},
    stepExecution: ({ fn }) => fn({ recordStepGas() {}, recordStepGasCost() {}, recordStepGasPrice() {} }),
  };
  return flow;
}

test("a failed attempt resets the SDK so the next attempt re-detects the withdrawal protocol", async () => {
  const stale = fakeSdk("stale", { quoteError: new Error("execution reverted") });
  const fresh = fakeSdk("fresh");
  const manager = fakeSdkManager([stale, fresh]);
  const flow = setup(manager);

  assert.equal(await flow.executeWatchdogWithdrawal(), StatusNoSkip.FAIL);
  assert.deepEqual(manager.resets, ["stale"]);

  assert.equal(await flow.executeWatchdogWithdrawal(), StatusNoSkip.OK);
  assert.deepEqual(fresh.calls, ["quote", "create", "wait"]);
});

test("a successful attempt keeps the current SDK", async () => {
  const sdk = fakeSdk("current");
  const manager = fakeSdkManager([sdk]);
  const flow = setup(manager);

  assert.equal(await flow.executeWatchdogWithdrawal(), StatusNoSkip.OK);
  assert.deepEqual(manager.resets, []);
});
