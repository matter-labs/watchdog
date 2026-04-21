import test from "node:test";
import assert from "node:assert/strict";

import { resolveDepositPriorityFeeFloor } from "../src/depositPriorityFee";

type FeeData = {
  maxPriorityFeePerGas: bigint | null;
};

const makeProvider = (maxPriorityFeePerGas: bigint | null) => ({
  getFeeData: async (): Promise<FeeData> => ({ maxPriorityFeePerGas }),
});

test("uses the configured minimum when provider tip is lower", async () => {
  process.env.FLOW_DEPOSIT_MIN_PRIORITY_FEE_GWEI = "0.001";

  const fee = await resolveDepositPriorityFeeFloor(makeProvider(100000n));

  assert.equal(fee, 1000000n);
});

test("keeps the provider tip when it is already higher", async () => {
  process.env.FLOW_DEPOSIT_MIN_PRIORITY_FEE_GWEI = "0.001";

  const fee = await resolveDepositPriorityFeeFloor(makeProvider(2000000n));

  assert.equal(fee, 2000000n);
});

test("falls back to the default minimum when the provider tip is missing", async () => {
  delete process.env.FLOW_DEPOSIT_MIN_PRIORITY_FEE_GWEI;

  const fee = await resolveDepositPriorityFeeFloor(makeProvider(null));

  assert.equal(fee, 1000000n);
});
