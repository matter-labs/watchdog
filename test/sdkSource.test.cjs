const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSdkSource } = require("../src/sdkSource");

function setup() {
  let refreshes = 0;
  const client = { refresh: () => refreshes++ };
  let built = 0;
  const source = createSdkSource(
    () => client,
    () => ({ id: ++built })
  );
  return { source, refreshes: () => refreshes, built: () => built };
}

test("reuses one SDK instance until reset", () => {
  const { source, built } = setup();
  assert.equal(source.current(), source.current());
  assert.equal(built(), 1);
});

test("reset discards the SDK and cached client addresses so the next SDK re-detects the protocol", () => {
  const { source, refreshes } = setup();
  const before = source.current();
  source.reset();
  const after = source.current();
  assert.notEqual(after, before);
  assert.equal(after.id, 2);
  assert.equal(refreshes(), 1);
});
