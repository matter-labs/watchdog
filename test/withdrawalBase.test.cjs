const assert = require("node:assert/strict");
const { test } = require("node:test");
const { id, zeroPadValue } = require("ethers");
const { WithdrawalFlow } = require("../src/withdrawal");
const { WithdrawalReceiptStore } = require("../src/withdrawalBase");

const wallet = "0x0000000000000000000000000000000000000001";
const NTV = "0x0000000000000000000000000000000000010004";
const BRIDGE_BURN = id("BridgeBurn(uint256,bytes32,address,address,uint256)");

function log(blockNumber, hash) {
  return {
    blockNumber,
    async getBlock() {
      return { timestamp: blockNumber * 10 };
    },
    async getTransactionReceipt() {
      return { hash, blockNumber, status: 1 };
    },
  };
}

function setup({ head = 50_000, logs = [] } = {}) {
  const queries = [];
  const provider = {
    async getBlock() {
      return { number: head, timestamp: head * 10 };
    },
    async getLogs(filter) {
      queries.push(filter);
      return logs;
    },
  };
  const flow = new WithdrawalFlow({ address: wallet, provider }, { withLock: (fn) => fn() }, 1, {}, new WithdrawalReceiptStore());
  return { flow, queries };
}

function withMaxLogsBlocks(value, fn) {
  return async () => {
    const saved = process.env.MAX_LOGS_BLOCKS_L2;
    if (value === undefined) delete process.env.MAX_LOGS_BLOCKS_L2;
    else process.env.MAX_LOGS_BLOCKS_L2 = value;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.MAX_LOGS_BLOCKS_L2;
      else process.env.MAX_LOGS_BLOCKS_L2 = saved;
    }
  };
}

test(
  "looks up the wallet's BridgeBurn on the native token vault over the last 1000 blocks by default",
  withMaxLogsBlocks(undefined, async () => {
    const { flow, queries } = setup();
    await flow.getLastExecution("finalized", wallet);
    assert.deepEqual(queries, [
      { address: NTV, topics: [BRIDGE_BURN, null, null, zeroPadValue(wallet, 32)], fromBlock: 49_000, toBlock: 50_000 },
    ]);
  })
);

test(
  "caps the window at the RPC's 10000-block limit",
  withMaxLogsBlocks("50000", async () => {
    const { flow, queries } = setup();
    await flow.getLastExecution("latest", wallet);
    assert.equal(queries[0].toBlock - queries[0].fromBlock, 10_000);
  })
);

test(
  "MAX_LOGS_BLOCKS_L2=0 turns the lookup off",
  withMaxLogsBlocks("0", async () => {
    const { flow, queries } = setup();
    assert.equal(await flow.getLastExecution("latest", wallet), null);
    assert.deepEqual(queries, []);
  })
);

test(
  "returns the newest withdrawal",
  withMaxLogsBlocks(undefined, async () => {
    const { flow } = setup({ logs: [log(49_100, "0xold"), log(49_900, "0xnew"), log(49_500, "0xmid")] });
    const result = await flow.getLastExecution("latest", wallet);
    assert.equal(result.l2Receipt.hash, "0xnew");
    assert.equal(result.timestampL2, 499_000);
  })
);

test("the receipt store keeps more than 10 receipts", () => {
  const store = new WithdrawalReceiptStore();
  for (let block = 1; block <= 60; block++) store.add({ blockNumber: block }, block);
  assert.equal(store.getFinalizeCandidates(60).length, 60);
});
