const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSdkManager } = require("../src/sdkManager");

function setup() {
  let refreshes = 0;
  const client = { refresh: () => refreshes++ };
  let built = 0;
  const manager = createSdkManager(
    () => client,
    () => ({ id: ++built })
  );
  return { manager, refreshes: () => refreshes, built: () => built };
}

test("reuses one SDK instance until reset", () => {
  const { manager, built } = setup();
  assert.equal(manager.get(), manager.get());
  assert.equal(built(), 1);
});

test("reset discards the SDK and cached client addresses so the next SDK re-detects the protocol", () => {
  const { manager, refreshes } = setup();
  const before = manager.get();
  manager.reset();
  const after = manager.get();
  assert.notEqual(after, before);
  assert.equal(after.id, 2);
  assert.equal(refreshes(), 1);
});

test("reset recovers token metadata after the SDK caches a rejected RPC promise", async () => {
  let reads = 0;
  const assetId = "0x" + "aa".repeat(32);
  const client = {
    refresh() {},
    async contracts() {
      return {
        l2NativeTokenVault: {
          async BASE_TOKEN_ASSET_ID() {
            if (++reads === 1) throw new Error("temporary RPC outage");
            return assetId;
          },
        },
      };
    },
  };
  const manager = createSdkManager(() => client);

  await assert.rejects(manager.get().tokens.baseTokenAssetId());
  await assert.rejects(manager.get().tokens.baseTokenAssetId());
  assert.equal(reads, 1);

  manager.reset();
  assert.equal(await manager.get().tokens.baseTokenAssetId(), assetId);
  assert.equal(reads, 2);
});
