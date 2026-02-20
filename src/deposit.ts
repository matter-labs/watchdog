import "dotenv/config";

import { formatEther, MaxInt256, parseEther, toBigInt } from "ethers";
import { utils } from "zksync-ethers";
import { ETH_ADDRESS_IN_CONTRACTS } from "zksync-ethers/build/utils";

import {
  DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI,
  DEPOSIT_RETRY_INTERVAL,
  DEPOSIT_RETRY_LIMIT,
  DepositBaseFlow,
  PRIORITY_OP_TIMEOUT,
  STEPS,
} from "./depositBase";
import { recordL1Balances, Status } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise } from "./utils";

import type { BigNumberish, BytesLike, Overrides, Provider as EthersProvider } from "ethers";
import type { Wallet } from "zksync-ethers";
import type { IL1SharedBridge } from "zksync-ethers/build/typechain";
import type { Address } from "zksync-ethers/build/types";

const FLOW_NAME = "deposit";
type L2Request = {
  contractAddress: Address;
  calldata: string;
  l2GasLimit?: BigNumberish;
  mintValue?: BigNumberish;
  l2Value?: BigNumberish;
  factoryDeps?: BytesLike[];
  operatorTip?: BigNumberish;
  gasPerPubdataByte?: BigNumberish;
  refundRecipient?: Address;
  overrides?: Overrides;
};

export class DepositFlow extends DepositBaseFlow {
  constructor(
    wallet: Wallet,
    sharedBridge: IL1SharedBridge,
    zkChainAddress: string,
    chainId: bigint,
    baseToken: string,
    l2EthersProvider: EthersProvider,
    isZKsyncOS: boolean,
    private intervalMs: number
  ) {
    super(wallet, sharedBridge, zkChainAddress, chainId, baseToken, l2EthersProvider, isZKsyncOS, FLOW_NAME);
  }

  protected async executeWatchdogDeposit(): Promise<Status> {
    try {
      // even before flow start we check base token allowance and perform an unlimited approval if needed
      if (this.baseToken != ETH_ADDRESS_IN_CONTRACTS) {
        const bridgeAddress = await this.sharedBridge.getAddress();
        const allowance = await this.wallet.getAllowanceL1(this.baseToken, bridgeAddress);

        // heuristic condition to determine if we should perform the infinite approval
        if (allowance < parseEther("100000")) {
          this.logger.info(`Approving base token ${this.baseToken} for infinite amount`);
          let overrides = {};
          if (this.isZKsyncOS) {
            overrides = {
              bridgeAddress,
            };
          }
          await this.wallet.approveERC20(this.baseToken, MaxInt256, overrides);
        } else {
          this.logger.info(`Base token ${this.baseToken} already has approval`);
        }
        const baseTokenBalance = await this.wallet.getBalanceL1(this.baseToken);
        const l1EthBalance = await this.wallet._providerL1().getBalance(this.wallet.address);
        this.logger.info(
          `L1 balance: Base token (${this.baseToken}) ${formatEther(baseTokenBalance.toString())}; ETH: ${formatEther(l1EthBalance.toString())}`
        );
        recordL1Balances(baseTokenBalance, l1EthBalance);
      }

      this.metricRecorder.recordFlowStart();

      const populatedWithOverrides = await this.metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 30 * SEC,
        fn: async ({ recordStepGas, recordStepGasCost, recordStepGasPrice }) => {
          const populated: L2Request = await this.wallet.getDepositTx(this.getDepositRequest());
          const maxFeePerGas = toBigInt(unwrap(populated.overrides?.maxFeePerGas)); // we expect the library to populate this field as we are post EIP-1559
          const estimatedGas = await this.wallet.estimateGasRequestExecute(populated);
          const nonce = await this.wallet._signerL1().getNonce("latest");
          recordStepGas(estimatedGas);
          recordStepGasPrice(maxFeePerGas);
          recordStepGasCost(estimatedGas * maxFeePerGas);
          return {
            ...populated,
            overrides: {
              ...populated.overrides,
              gasLimit: estimatedGas,
              nonce,
              maxFeePerGas,
            },
          };
        },
      });
      // record l2 estimates using the manual record function
      this.metricRecorder.manualRecordStepGas(STEPS.l2_estimation, unwrap(populatedWithOverrides.l2GasLimit));
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l2_estimation,
        BigInt(unwrap(populatedWithOverrides.mintValue)) - BigInt(unwrap(populatedWithOverrides.l2Value))
      );
      if (populatedWithOverrides.overrides.maxFeePerGas > DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI) {
        this.logger.warn(
          `Gas price ${populatedWithOverrides.overrides.maxFeePerGas} is higher than limit ${DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI}. Skipping deposit`
        );
        this.metricRecorder.recordFlowSkipped();
        return Status.SKIP;
      }

      // send L1 deposit transaction
      const depositHandle = await this.metricRecorder.stepExecution({
        stepName: STEPS.send,
        stepTimeoutMs: 30 * SEC,
        fn: () => this.wallet.requestExecute(populatedWithOverrides),
      });
      this.logger.info(`Tx (L1: ${depositHandle.hash}) sent on L1`);

      // wait for transaction
      const txReceipt = await this.metricRecorder.stepExecution({
        stepName: STEPS.l1_execution,
        stepTimeoutMs: 3 * MIN,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const txReceipt = await depositHandle.waitL1Commit(1);
          recordStepGas(unwrap(txReceipt?.gasUsed));
          recordStepGasPrice(unwrap(txReceipt?.gasPrice));
          recordStepGasCost(unwrap(txReceipt?.gasUsed) * unwrap(txReceipt?.gasPrice));
          return txReceipt;
        },
      }); // included in a block on L1

      const l2TxHash = utils.getL2HashFromPriorityOp(txReceipt, this.zkChainAddress);
      const txHashs = `(L1: ${depositHandle.hash}, L2: ${l2TxHash})`;
      this.logger.info(`Tx ${txHashs} mined on l1`);
      // wait for deposit to be finalized
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l2_execution,
        stepTimeoutMs: PRIORITY_OP_TIMEOUT,
        fn: async ({ recordStepGasPrice, recordStepGas, recordStepGasCost }) => {
          const receipt = unwrap(await this.l2EthersProvider.waitForTransaction(l2TxHash, 1));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasCost(unwrap(receipt.gasUsed) * unwrap(receipt.gasPrice));
        },
      });
      this.logger.info(`Tx ${txHashs} mined on L2`);

      this.metricRecorder.recordFlowSuccess();
      return Status.OK;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.logger.error("deposit tx error: " + error?.message, error?.stack);
      this.metricRecorder.recordFlowFailure();
      return Status.FAIL;
    }
  }

  public async run() {
    const lastExecution = await this.getLastExecution(this.wallet.address);
    const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
    const timeSinceLastDepositSec = currentBlockchainTimestamp - lastExecution.timestampL1;
    if (lastExecution.status != null) this.metricRecorder.recordPreviousExecutionStatus(lastExecution.status!);
    if (timeSinceLastDepositSec < this.intervalMs / SEC) {
      const waitTime = this.intervalMs - timeSinceLastDepositSec * SEC;
      this.logger.info(`Waiting ${(waitTime / 1000).toFixed(0)} seconds before starting deposit flow`);
      await timeoutPromise(waitTime);
    }
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      let attempt: number = 1;
      while (attempt <= DEPOSIT_RETRY_LIMIT) {
        const result = await this.executeWatchdogDeposit();
        switch (result) {
          case Status.OK:
            this.logger.info(`attempt ${attempt} succeeded`);
            break;
          case Status.SKIP:
            this.logger.info(`attempt ${attempt} skipped (not counted towards limit)`);
            break;
          case Status.FAIL: {
            attempt++;
            this.logger.warn(
              `[deposit] attempt ${attempt} of ${DEPOSIT_RETRY_LIMIT} failed` +
                (attempt != DEPOSIT_RETRY_LIMIT
                  ? `, retrying in ${(DEPOSIT_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                  : "")
            );
            await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
            break;
          }
          default: {
            const _exhaustiveCheck: never = result;
            throw new Error(`Unreachable code branch: ${_exhaustiveCheck}`);
          }
        }
        if (result == Status.OK) break;
      }
      await nextExecutionWait;
    }
  }
}
