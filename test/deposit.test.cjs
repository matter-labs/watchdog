const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MaxInt256 } = require("ethers");
const { ETH_ADDRESS } = require("@matterlabs/zksync-js/core");
const { DepositFlow } = require("../src/deposit");
const depositBase = require("../src/depositBase");
const { Status } = require("../src/flowMetric");
const { createSdkManager } = require("../src/sdkManager");

const wallet = "0x0000000000000000000000000000000000000001";
const token = "0x0000000000000000000000000000000000000002";
const router = "0x0000000000000000000000000000000000000003";
const vault = "0x0000000000000000000000000000000000000004";

function setup(t, { allowances = {}, baseToken = token, approvalError, sdkFactory } = {}) {
  const events = [];
  const balances = new Map(Object.entries(allowances));
  t.mock.method(depositBase, "getErc20Contract", () => ({
    async allowance(owner, spender) {
      assert.equal(owner, wallet);
      events.push(`allowance:${spender}`);
      return balances.get(spender) ?? 0n;
    },
    async approve(spender, amount) {
      assert.equal(amount, MaxInt256);
      events.push(`approve:${spender}`);
      return {
        async wait(confirmations) {
          assert.equal(confirmations, 1);
          await new Promise(setImmediate);
          events.push(`mined:${spender}`);
          if (approvalError) throw approvalError;
          balances.set(spender, amount);
        },
      };
    },
    async balanceOf() {
      return 10n ** 24n;
    },
  }));
  const sdk = {
    contracts: {
      async addresses() {
        events.push("addresses");
        return { l1AssetRouter: router, l1NativeTokenVault: vault };
      },
    },
    deposits: {
      async quote(params) {
        events.push("quote");
        // Exercise approval preparation and stop at the gas-price guard without sending a deposit.
        return {
          fees: {
            mintValue: params.amount + 7n,
            l1: {
              gasLimit: 1n,
              maxFeePerGas: depositBase.DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI + 1n,
              maxTotal: 1n,
            },
            l2: { gasLimit: 1n, total: 1n },
          },
        };
      },
    },
  };
  let refreshes = 0;
  const client = {
    l1: { getBalance: async () => 1n, getFeeData: async () => ({ maxPriorityFeePerGas: 1n }) },
    refresh: () => refreshes++,
  };
  const sdkManager = createSdkManager(() => client, sdkFactory ?? (() => sdk));
  const flow = new DepositFlow({ address: wallet }, client, sdkManager, 1);
  flow.baseToken = baseToken;
  flow.sharedBridge = { getAddress: async () => router };
  flow.logger = { info() {}, warn() {}, error() {} };
  flow.metricRecorder = {
    recordFlowStart() {},
    recordFlowSuccess() {},
    recordFlowFailure() {},
    recordFlowSkipped() {},
    manualRecordStepGas() {},
    manualRecordStepGasCost() {},
    stepExecution: ({ fn }) => fn({ recordStepGas() {}, recordStepGasCost() {}, recordStepGasPrice() {} }),
  };
  return { flow, events, balances, sdkManager, refreshes: () => refreshes };
}

test("approves the vault even when the router already has an unlimited allowance", async (t) => {
  const { flow, events, balances } = setup(t, { allowances: { [router]: MaxInt256 } });
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.equal(balances.get(vault), MaxInt256);
  assert.deepEqual(events, [
    "quote",
    "addresses",
    `allowance:${router}`,
    `allowance:${vault}`,
    `approve:${vault}`,
    `mined:${vault}`,
  ]);
});

test("confirms both approvals sequentially for a new wallet", async (t) => {
  const { flow, events } = setup(t);
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.deepEqual(events, [
    "quote",
    "addresses",
    `allowance:${router}`,
    `approve:${router}`,
    `mined:${router}`,
    `allowance:${vault}`,
    `approve:${vault}`,
    `mined:${vault}`,
  ]);
});

test("does not send approvals when both spenders already have sufficient allowance", async (t) => {
  const { flow, events } = setup(t, { allowances: { [router]: MaxInt256, [vault]: MaxInt256 } });
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.deepEqual(events, ["quote", "addresses", `allowance:${router}`, `allowance:${vault}`]);
});

test("stops before submission after an approval fails to confirm", async (t) => {
  const { flow, events } = setup(t, {
    allowances: { [router]: MaxInt256 },
    approvalError: new Error("approval reverted"),
  });
  assert.equal(await flow.executeWatchdogDeposit(), Status.FAIL);
  assert.equal(events.at(-1), `mined:${vault}`);
});

test("ETH-base deposits do not resolve or approve ERC-20 spenders", async (t) => {
  const { flow, events, refreshes } = setup(t, { baseToken: ETH_ADDRESS });
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.deepEqual(events, ["quote"]);
  assert.equal(refreshes(), 0);
});

function fakeDepositSdk({ quoteError, createError, onQuote } = {}) {
  const calls = [];
  const createParams = [];
  return {
    calls,
    createParams,
    deposits: {
      async quote(params) {
        calls.push("quote");
        if (quoteError) throw quoteError;
        onQuote?.();
        return {
          fees: {
            l1: { gasLimit: 1n, maxFeePerGas: params.l1TxOverrides?.maxFeePerGas ?? 1n, maxTotal: 1n },
            l2: { gasLimit: 1n, total: 1n },
          },
        };
      },
      async create(params) {
        calls.push("create");
        createParams.push(params);
        if (createError) throw createError;
        return { l1TxHash: "0xabc" };
      },
      async wait(_handle, { for: stage }) {
        calls.push(`wait:${stage}`);
        return { gasUsed: 1n, gasPrice: 1n, logs: [] };
      },
    },
  };
}

test("retries a failed deposit with a fresh SDK and keeps it after success", async (t) => {
  const failed = fakeDepositSdk({ quoteError: new Error("temporary RPC outage") });
  const healthy = fakeDepositSdk();
  const sdks = [failed, healthy];
  const { flow, sdkManager, refreshes } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdks.shift() });

  assert.equal(await flow.executeWatchdogDeposit(), Status.FAIL);
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.deepEqual(failed.calls, ["quote"]);
  assert.deepEqual(healthy.calls, ["quote", "create", "wait:l1", "wait:l2"]);
  assert.equal(sdkManager.get(), healthy);
  assert.equal(refreshes(), 1);
});

test("keeps one SDK throughout a deposit even if another flow resets the manager", async (t) => {
  const current = fakeDepositSdk({ onQuote: () => sdkManager.reset() });
  const next = fakeDepositSdk();
  const sdks = [current, next];
  const { flow, sdkManager } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdks.shift() });

  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.deepEqual(current.calls, ["quote", "create", "wait:l1", "wait:l2"]);
  assert.deepEqual(next.calls, []);
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.deepEqual(next.calls, ["quote", "create", "wait:l1", "wait:l2"]);
});

test("preserves fee-bump recovery using a fresh SDK after an underpriced deposit", async (t) => {
  const error = Object.assign(new Error("replacement underpriced"), {
    envelope: { cause: { code: "REPLACEMENT_UNDERPRICED" } },
  });
  const failed = fakeDepositSdk({ createError: error });
  const healthy = fakeDepositSdk();
  t.mock.method(healthy.deposits, "quote").mock.mockImplementationOnce(async () => {
    healthy.calls.push("quote");
    return { fees: { l1: { maxFeePerGas: 9n, maxPriorityFeePerGas: 3n } } };
  });
  const sdks = [failed, healthy];
  const { flow, refreshes } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdks.shift() });

  const run = {};
  assert.equal(await flow.executeWatchdogDeposit(run), Status.FAIL);
  assert.deepEqual(failed.calls, ["quote", "create"]);
  assert.deepEqual(healthy.calls, ["quote"]);

  assert.equal(await flow.executeWatchdogDeposit(run), Status.OK);
  assert.equal(healthy.createParams[0].l1TxOverrides.maxFeePerGas, 9n);
  assert.equal(refreshes(), 1);
});

test("a scheduled run uses market fees after an earlier retry exceeded the cap", async (t) => {
  const sdk = fakeDepositSdk();
  const { flow } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdk });
  t.mock.method(sdk.deposits, "create").mock.mockImplementationOnce(async () => {
    throw Object.assign(new Error("underpriced"), { envelope: { cause: { code: "REPLACEMENT_UNDERPRICED" } } });
  });
  t.mock.method(flow, "computeBumpedFees", async () => ({
    maxFeePerGas: depositBase.DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI + 1n,
    maxPriorityFeePerGas: 1n,
  }));
  const run = {};
  assert.equal(await flow.executeWatchdogDeposit(run), Status.FAIL);
  assert.equal(await flow.executeWatchdogDeposit(run), Status.SKIP);
  assert.equal(await flow.executeWatchdogDeposit({}), Status.OK);
  assert.equal(sdk.createParams[0].l1TxOverrides.maxFeePerGas, 1n);
});

test("validates the amount when constructing the flow and includes fees in the vault allowance", async (t) => {
  const original = process.env.FLOW_DEPOSIT_AMOUNT_WEI;
  try {
    process.env.FLOW_DEPOSIT_AMOUNT_WEI = "1e18";
    assert.throws(() => new DepositFlow({}, {}, {}, 1), /FLOW_DEPOSIT_AMOUNT_WEI/);
    const amount = 10n ** 23n;
    process.env.FLOW_DEPOSIT_AMOUNT_WEI = amount.toString();
    const { flow, balances } = setup(t, { allowances: { [router]: amount + 7n, [vault]: amount } });
    assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
    assert.equal(balances.get(router), amount + 7n);
    assert.equal(balances.get(vault), MaxInt256);
  } finally {
    if (original === undefined) delete process.env.FLOW_DEPOSIT_AMOUNT_WEI;
    else process.env.FLOW_DEPOSIT_AMOUNT_WEI = original;
  }
});

test("retries L2 confirmation with the same SDK handle", async (t) => {
  const sdk = fakeDepositSdk();
  const wait = t.mock.method(sdk.deposits, "wait");
  wait.mock.mockImplementationOnce(async () => {
    throw new Error("L2 timeout");
  }, 1);
  const { flow } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdk });
  const run = {};
  assert.equal(await flow.executeWatchdogDeposit(run), Status.FAIL);
  assert.equal(await flow.executeWatchdogDeposit(run), Status.OK);
  assert.equal(sdk.createParams.length, 1);
  assert.ok(wait.mock.calls.every((call) => call.arguments[0] === run.handle));
});

test("a lost create response ends the scheduled run", async (t) => {
  const sdk = fakeDepositSdk({ createError: new Error("connection reset") });
  const { flow } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdk });
  assert.equal(await flow.executeWatchdogDeposit({}), "submission-unknown");
  assert.equal(sdk.createParams.length, 1);
});
