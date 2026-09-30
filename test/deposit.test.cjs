const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MaxInt256, parseEther } = require("ethers");
const { ETH_ADDRESS } = require("@matterlabs/zksync-js/core");
const { DepositFlow, readL2TopUpConfig } = require("../src/deposit");
const depositBase = require("../src/depositBase");
const { Status } = require("../src/flowMetric");
const { createSdkManager } = require("../src/sdkManager");

const wallet = "0x0000000000000000000000000000000000000001";
const token = "0x0000000000000000000000000000000000000002";
const router = "0x0000000000000000000000000000000000000003";
const vault = "0x0000000000000000000000000000000000000004";

function setup(t, { allowances = {}, baseToken = token, approvalError, sdkFactory, l1Balance = 1n, l2Balance } = {}) {
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
      async quote() {
        events.push("quote");
        // Exercise approval preparation and stop at the gas-price guard without sending a deposit.
        return {
          fees: {
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
  const l2BalanceReads = [];
  const client = {
    l1: { getBalance: async () => l1Balance },
    l2: {
      async getBalance(address) {
        l2BalanceReads.push(address);
        if (l2Balance instanceof Error) throw l2Balance;
        return l2Balance;
      },
    },
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
  return { flow, events, balances, sdkManager, refreshes: () => refreshes, l2BalanceReads };
}

test("approves the vault even when the router already has an unlimited allowance", async (t) => {
  const { flow, events, balances } = setup(t, { allowances: { [router]: MaxInt256 } });
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.equal(balances.get(vault), MaxInt256);
  assert.deepEqual(events, [
    "addresses",
    `allowance:${router}`,
    `allowance:${vault}`,
    `approve:${vault}`,
    `mined:${vault}`,
    "quote",
  ]);
});

test("confirms both approvals sequentially for a new wallet before quoting", async (t) => {
  const { flow, events } = setup(t);
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.deepEqual(events, [
    "addresses",
    `allowance:${router}`,
    `approve:${router}`,
    `mined:${router}`,
    `allowance:${vault}`,
    `approve:${vault}`,
    `mined:${vault}`,
    "quote",
  ]);
});

test("does not send approvals when both spenders already have sufficient allowance", async (t) => {
  const { flow, events } = setup(t, { allowances: { [router]: MaxInt256, [vault]: MaxInt256 } });
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.deepEqual(events, ["addresses", `allowance:${router}`, `allowance:${vault}`, "quote"]);
});

test("does not quote or submit a deposit after an approval fails to confirm", async (t) => {
  const { flow, events } = setup(t, {
    allowances: { [router]: MaxInt256 },
    approvalError: new Error("approval reverted"),
  });
  assert.equal(await flow.executeWatchdogDeposit(), Status.FAIL);
  assert.equal(events.includes("quote"), false);
});

test("ETH-base deposits do not resolve or approve ERC-20 spenders", async (t) => {
  const { flow, events, refreshes } = setup(t, { baseToken: ETH_ADDRESS });
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.deepEqual(events, ["quote"]);
  assert.equal(refreshes(), 0);
});

function fakeDepositSdk({ quoteError, createError, onQuote, l2WaitErrors = [] } = {}) {
  const calls = [];
  const quoteParams = [];
  const createParams = [];
  return {
    calls,
    quoteParams,
    createParams,
    deposits: {
      async quote(params) {
        calls.push("quote");
        quoteParams.push(params);
        if (quoteError) throw quoteError;
        onQuote?.();
        return {
          fees: {
            maxTotal: 2n,
            l1: { gasLimit: 1n, maxFeePerGas: 1n, maxTotal: 1n },
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
        if (stage === "l2" && l2WaitErrors.length > 0) throw l2WaitErrors.shift();
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
  const sdks = [failed, healthy];
  const { flow, refreshes } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdks.shift() });

  assert.equal(await flow.executeWatchdogDeposit(), Status.FAIL);
  assert.deepEqual(failed.calls, ["quote", "create"]);
  assert.deepEqual(healthy.calls, ["quote"]);

  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.equal(healthy.createParams[0].l1TxOverrides.maxFeePerGas, 1n);
  assert.equal(flow.feeOverride, null);
  assert.equal(refreshes(), 1);
});

test("reads no L2 top-up settings when neither is set, and rejects incomplete or inverted ones", () => {
  assert.equal(readL2TopUpConfig({}), null);
  assert.deepEqual(readL2TopUpConfig({ FLOW_DEPOSIT_L2_BALANCE_MIN: "0.5", FLOW_DEPOSIT_L2_BALANCE_TARGET: "1.5" }), {
    min: parseEther("0.5"),
    target: parseEther("1.5"),
  });
  assert.throws(() => readL2TopUpConfig({ FLOW_DEPOSIT_L2_BALANCE_TARGET: "1.5" }), /must be set together/);
  assert.throws(() => readL2TopUpConfig({ FLOW_DEPOSIT_L2_BALANCE_MIN: "0.5" }), /must be set together/);
  assert.throws(
    () => readL2TopUpConfig({ FLOW_DEPOSIT_L2_BALANCE_MIN: "2", FLOW_DEPOSIT_L2_BALANCE_TARGET: "1.5" }),
    /needs 0 </
  );
  assert.throws(
    () => readL2TopUpConfig({ FLOW_DEPOSIT_L2_BALANCE_MIN: "0", FLOW_DEPOSIT_L2_BALANCE_TARGET: "1.5" }),
    /needs 0 </
  );
  assert.throws(() => readL2TopUpConfig({ FLOW_DEPOSIT_L2_BALANCE_MIN: "abc", FLOW_DEPOSIT_L2_BALANCE_TARGET: "1" }));
});

const topUp = { min: parseEther("0.5"), target: parseEther("1.5") };

function setupTopUp(t, options) {
  const sdk = fakeDepositSdk(options.sdk);
  const ctx = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdk, ...options });
  ctx.flow.l2TopUp = topUp;
  return { ...ctx, sdk };
}

test("never reads the L2 balance when top-up is not configured", async (t) => {
  const sdk = fakeDepositSdk();
  const { flow, l2BalanceReads } = setup(t, { baseToken: ETH_ADDRESS, sdkFactory: () => sdk, l2Balance: 0n });
  assert.equal(flow.l2TopUp, null);
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.deepEqual(l2BalanceReads, []);
  assert.equal(sdk.createParams[0].amount, 1n);
});

test("tops the L2 balance up to the target once it falls below the minimum", async (t) => {
  const { flow, sdk, l2BalanceReads } = setupTopUp(t, { l1Balance: parseEther("10"), l2Balance: parseEther("0.1") });
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.deepEqual(l2BalanceReads, [wallet]);
  assert.deepEqual(
    sdk.quoteParams.map((p) => p.amount),
    [1n, parseEther("1.4")]
  );
  assert.equal(sdk.createParams[0].amount, parseEther("1.4"));
  assert.equal(sdk.createParams[0].to, wallet);
  assert.equal(flow.depositPending, false);
});

test("deposits 1 wei while the L2 balance is at or above the minimum", async (t) => {
  const { flow, sdk } = setupTopUp(t, { l1Balance: parseEther("10"), l2Balance: topUp.min });
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.deepEqual(
    sdk.quoteParams.map((p) => p.amount),
    [1n]
  );
  assert.equal(sdk.createParams[0].amount, 1n);
});

test("tops up only when the L1 balance covers the amount plus the deposit fees", async (t) => {
  // 1.4 ETH is missing on L2 and the fake quote prices the deposit fees at 2 wei.
  const short = setupTopUp(t, { l1Balance: parseEther("1.4") + 1n, l2Balance: parseEther("0.1") });
  assert.equal(await short.flow.executeWatchdogDeposit(), Status.OK);
  assert.equal(short.sdk.createParams[0].amount, 1n);

  const exact = setupTopUp(t, { l1Balance: parseEther("1.4") + 2n, l2Balance: parseEther("0.1") });
  assert.equal(await exact.flow.executeWatchdogDeposit(), Status.OK);
  assert.equal(exact.sdk.createParams[0].amount, parseEther("1.4"));
});

test("deposits 1 wei when the L2 balance cannot be read", async (t) => {
  const { flow, sdk } = setupTopUp(t, { l1Balance: parseEther("10"), l2Balance: new Error("Unauthorized") });
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.equal(sdk.createParams[0].amount, 1n);
});

test("does not top up again until the previous deposit has executed on L2", async (t) => {
  const { flow, sdk, l2BalanceReads } = setupTopUp(t, {
    l1Balance: parseEther("10"),
    l2Balance: parseEther("0.1"),
    sdk: { l2WaitErrors: [new Error("priority op timed out")] },
  });

  // The top-up is mined on L1 but its L2 execution is not confirmed.
  assert.equal(await flow.executeWatchdogDeposit(), Status.FAIL);
  assert.equal(sdk.createParams[0].amount, parseEther("1.4"));
  assert.equal(flow.depositPending, true);

  // The L2 balance still looks low, but the funds may be in flight: only 1 wei, without reading it.
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.equal(sdk.createParams[1].amount, 1n);
  assert.equal(l2BalanceReads.length, 1);
  assert.equal(flow.depositPending, false);

  // Once a deposit has executed on L2 the balance is complete again, and a real shortfall is topped up.
  assert.equal(await flow.executeWatchdogDeposit(), Status.OK);
  assert.equal(sdk.createParams[2].amount, parseEther("1.4"));
});

test("a deposit that fails before reaching L1 still blocks the next top-up", async (t) => {
  const { flow, sdk } = setupTopUp(t, {
    l1Balance: parseEther("10"),
    l2Balance: parseEther("0.1"),
    sdk: { createError: new Error("nonce too low") },
  });
  assert.equal(await flow.executeWatchdogDeposit(), Status.FAIL);
  assert.equal(sdk.createParams[0].amount, parseEther("1.4"));
  assert.equal(flow.depositPending, true);
});
