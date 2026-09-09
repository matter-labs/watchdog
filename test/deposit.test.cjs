const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MaxInt256 } = require("ethers");
const { ETH_ADDRESS } = require("@matterlabs/zksync-js/core");
const { DepositFlow } = require("../src/deposit");
const depositBase = require("../src/depositBase");
const { Status } = require("../src/flowMetric");

const wallet = "0x0000000000000000000000000000000000000001";
const token = "0x0000000000000000000000000000000000000002";
const router = "0x0000000000000000000000000000000000000003";
const vault = "0x0000000000000000000000000000000000000004";

function setup(t, { allowances = {}, baseToken = token, approvalError } = {}) {
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
  const flow = new DepositFlow({ address: wallet }, { l1: { getBalance: async () => 1n } }, sdk, 1);
  flow.baseToken = baseToken;
  flow.sharedBridge = { getAddress: async () => router };
  flow.logger = { info() {}, warn() {}, error() {} };
  flow.metricRecorder = {
    recordFlowStart() {},
    recordFlowFailure() {},
    recordFlowSkipped() {},
    manualRecordStepGas() {},
    manualRecordStepGasCost() {},
    stepExecution: ({ fn }) => fn({ recordStepGas() {}, recordStepGasCost() {}, recordStepGasPrice() {} }),
  };
  return { flow, events, balances };
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
  const { flow, events } = setup(t, { baseToken: ETH_ADDRESS });
  assert.equal(await flow.executeWatchdogDeposit(), Status.SKIP);
  assert.deepEqual(events, ["quote"]);
});
