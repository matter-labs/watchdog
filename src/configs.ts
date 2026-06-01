import { MIN, SEC } from "./utils";

export const L2_EXECUTION_TIMEOUT = +(process.env.L2_EXECUTION_TIMEOUT ?? 3 * SEC);
export const SETTLEMENT_DEADLINE = +(process.env.SETTLEMENT_DEADLINE ?? 60 * MIN);
