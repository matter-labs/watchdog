const assert = require("node:assert/strict");
const { test } = require("node:test");
const { register } = require("prom-client");
const { Status } = require("../src/flowMetric");
const { WithdrawalReceiptStore } = require("../src/withdrawalBase");
const { WithdrawalFinalizeFlow } = require("../src/withdrawalFinalize");

const wallet = "0x0000000000000000000000000000000000000001";
const LEGACY = "0x" + "aa".repeat(32);
const INTEROP = "0x" + "bb".repeat(32);

// shape of the error zksync-js raises for a withdrawal created before the chain moved to interop bundles
function preInteropError() {
  const e = new Error("L2→L1 message is not an interop bundle");
  e.name = "ZKsyncError";
  e.envelope = {
    type: "STATE",
    resource: "withdrawals",
    operation: "withdrawals.finalize.fetchParams:decodeMessage",
    message:
      "L2→L1 message is not an interop bundle. This withdrawal was most likely initiated before the chain upgraded to protocol v32 and cannot be finalized through the interop handler.",
  };
  return e;
}

function fakeServices({ fetchError } = {}) {
  const estimated = [];
  return {
    estimated,
    async fetchFinalization(hash) {
      if (fetchError) throw fetchError;
      if (hash === LEGACY) throw preInteropError();
      return { finalization: { hash } };
    },
    async simulateFinalizeReadiness() {
      return { kind: "READY" };
    },
    async estimateFinalization(finalization) {
      estimated.push(finalization.hash);
      return { gasLimit: 1n };
    },
  };
}

function setup(services) {
  register.clear();
  const store = new WithdrawalReceiptStore();
  const provider = { async getBlock() { return { number: 100, timestamp: 1000 }; } };
  const created = [];
  const factory = () => {
    const svc = services.shift();
    created.push(svc);
    return svc;
  };
  const flow = new WithdrawalFinalizeFlow({ address: wallet, provider }, {}, 1, store, factory);
  flow.logger = { info() {}, warn() {}, error() {} };
  flow.metricRecorder = {
    recordFlowStart() {},
    recordFlowSuccess() {},
    recordFlowSkipped() {},
    recordFlowFailure() {},
    stepExecution: ({ fn }) => fn({ recordStepGas() {} }),
  };
  return { flow, store, created };
}

function receipt(hash, blockNumber) {
  return { hash, blockNumber };
}

test("skips a withdrawal initiated before the interop upgrade and finalizes the next candidate", async () => {
  const services = fakeServices();
  const { flow, store } = setup([services]);
  store.add(receipt(INTEROP, 10), 10);
  store.add(receipt(LEGACY, 20), 20); // newest first in candidates

  assert.equal(await flow.executeWithdrawalFinalize(), Status.OK);
  assert.deepEqual(services.estimated, [INTEROP]);
});

test("reports SKIP rather than FAIL when every candidate predates the interop upgrade", async () => {
  const services = fakeServices();
  const { flow, store } = setup([services]);
  store.add(receipt(LEGACY, 20), 20);

  assert.equal(await flow.executeWithdrawalFinalize(), Status.SKIP);
  assert.deepEqual(services.estimated, []);
});

test("recreates the finalization service after a failed run", async () => {
  const broken = fakeServices({ fetchError: new Error("Forbidden") });
  const healthy = fakeServices();
  const { flow, store, created } = setup([broken, healthy]);
  store.add(receipt(INTEROP, 10), 10);

  assert.equal(await flow.executeWithdrawalFinalize(), Status.FAIL);
  assert.equal(await flow.executeWithdrawalFinalize(), Status.OK);
  assert.deepEqual(created, [broken, healthy]);
  assert.deepEqual(healthy.estimated, [INTEROP]);
});
