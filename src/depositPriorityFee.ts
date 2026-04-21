import { parseUnits } from "ethers";

const DEPOSIT_MIN_PRIORITY_FEE_ENV = "FLOW_DEPOSIT_L1_MIN_PRIORITY_FEE_GWEI";
const DEFAULT_DEPOSIT_MIN_PRIORITY_FEE_GWEI = "0.001";

type FeeDataProvider = {
  getFeeData(): Promise<{
    maxPriorityFeePerGas: bigint | null;
  }>;
};

export const getDepositMinPriorityFeePerGas = (): bigint => {
  const configuredValue = process.env[DEPOSIT_MIN_PRIORITY_FEE_ENV] ?? DEFAULT_DEPOSIT_MIN_PRIORITY_FEE_GWEI;

  try {
    return parseUnits(configuredValue, "gwei");
  } catch {
    throw new Error(`Invalid ${DEPOSIT_MIN_PRIORITY_FEE_ENV} value "${configuredValue}": expected gwei amount`);
  }
};

export const resolveDepositPriorityFeeFloor = async (provider: FeeDataProvider): Promise<bigint> => {
  const providerTip = (await provider.getFeeData()).maxPriorityFeePerGas;
  const minimumTip = getDepositMinPriorityFeePerGas();

  if (providerTip == null || providerTip < minimumTip) {
    return minimumTip;
  }

  return providerTip;
};
