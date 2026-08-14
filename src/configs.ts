import { MIN, SEC } from "./utils";

export const L2_EXECUTION_TIMEOUT = +(process.env.L2_EXECUTION_TIMEOUT ?? 1 * SEC);
export const SETTLEMENT_DEADLINE = +(process.env.SETTLEMENT_DEADLINE ?? 90 * MIN);
export const L2_BALANCE_TIMEOUT = +(process.env.L2_BALANCE_TIMEOUT ?? 10 * SEC);

// Per-request timeouts for the JSON-RPC providers:
export const L2_RPC_TIMEOUT = +(process.env.L2_RPC_TIMEOUT ?? 5 * SEC);
export const L1_RPC_TIMEOUT = +(process.env.L1_RPC_TIMEOUT ?? 5 * SEC);
