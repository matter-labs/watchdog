import "dotenv/config";
import { Gauge } from "prom-client";
import { utils } from "zksync-ethers";

import {
  DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI,
  DEPOSIT_RETRY_INTERVAL,
  DEPOSIT_RETRY_LIMIT,
  DepositBaseFlow,
  STEPS,
} from "./depositBase";
import { Status } from "./flowMetric";
import { SEC, timeoutPromise, unwrap } from "./utils";

import type { ExecutionResultKnown } from "./depositBase";
import type { Provider as EthersProvider } from "ethers";
import type { Wallet } from "zksync-ethers";
import type { IL1SharedBridge } from "zksync-ethers/build/typechain";

const FLOW_NAME = "depositUser";
export class DepositUserFlow extends DepositBaseFlow {
  private lastOnChainOperationTimestamp: number = 0;
  private metricTimeSinceLastDeposit: Gauge;

  constructor(
    wallet: Wallet,
    sharedBridge: IL1SharedBridge,
    zkChainAddress: string,
    chainId: bigint,
    baseToken: string,
    l2EthersProvider: EthersProvider,
    isZKsyncOS: boolean,
    private intervalMs: number,
    private txTriggerDelayMs: number
  ) {
    super(wallet, sharedBridge, zkChainAddress, chainId, baseToken, l2EthersProvider, isZKsyncOS, FLOW_NAME);
    this.metricTimeSinceLastDeposit = new Gauge({
      name: "watchdog_time_since_last_deposit",
      help: "Blockchain second since last deposit transaction on L1",
    });
  }

  private recordDepositResult(result: ExecutionResultKnown) {
    if (result.status === Status.OK) {
      this.metricRecorder.manualRecordStatus(result.status, unwrap(result.timestampL2) - result.timestampL1);
      this.metricRecorder.manualRecordStepCompletion(
        STEPS.l1_execution,
        0, // not latency for L1 available
        result.timestampL1
      );
      this.metricRecorder.manualRecordStepGas(STEPS.l1_execution, result.l1Receipt.gasUsed);
      this.metricRecorder.manualRecordStepGasPrice(STEPS.l1_execution, result.l1Receipt.gasPrice);
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l1_execution,
        result.l1Receipt.gasUsed * result.l1Receipt.gasPrice
      );
      this.metricRecorder.manualRecordStepCompletion(
        STEPS.l2_execution,
        unwrap(result.timestampL2) - result.timestampL1,
        unwrap(result.timestampL2)
      );
      this.metricRecorder.manualRecordStepGas(STEPS.l2_execution, unwrap(result.l2Receipt).gasUsed);
      this.metricRecorder.manualRecordStepGasPrice(STEPS.l2_execution, unwrap(result.l2Receipt).gasPrice);
      this.metricRecorder.manualRecordStepGasCost(
        STEPS.l2_execution,
        unwrap(result.l2Receipt).gasUsed * unwrap(result.l2Receipt).gasPrice
      );
      this.metricTimeSinceLastDeposit.set(result.secSinceL1Deposit);
      this.logger.info(
        `Reported successful deposit. L1 hash: ${result.l1Receipt.hash}, L2 hash: ${result.l2Receipt?.hash}`
      );
    } else if (result.status === Status.FAIL) {
      this.logger.info(
        `Reported failed deposit. L1 hash: ${result.l1Receipt.hash}, L2 hash: ${result.l2Receipt?.hash}`
      );
      this.metricRecorder.manualRecordStatus(result.status, 0);
    } else {
      const _impossible: never = result.status;
      throw new Error(`Unexpected status ${result.status}`);
    }
  }

  private async executeDepositTx(): Promise<Status> {
    try {
      this.lastOnChainOperationTimestamp = await this.getCurrentChainTimestamp();
      const feeData = await this.wallet._providerL1().getFeeData();
      const maxFeePerGas = unwrap(feeData.maxFeePerGas);
      if (maxFeePerGas > DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI) {
        this.logger.warn(
          `Gas price ${maxFeePerGas} is higher than limit ${DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI}, skipping watchdog deposit`
        );
        this.metricRecorder.manualRecordStatus(Status.SKIP, 0);
        return Status.SKIP;
      }
      const depositHandle = await this.wallet.deposit({
        ...this.getDepositRequest(),
        overrides: {
          maxFeePerGas,
          maxPriorityFeePerGas: unwrap(feeData.maxPriorityFeePerGas),
        },
      });
      this.logger.info(`Deposit transaction sent ${depositHandle.hash}`);
      const txReceipt = await depositHandle.waitL1Commit(1);
      const l2TxHash = utils.getL2HashFromPriorityOp(
        txReceipt,
        await this.wallet._providerL2().getMainContractAddress()
      );
      this.logger.info(`Deposit transaction mined on L1, expecting L2 hash: ${l2TxHash}`);
      await depositHandle.wait(1);
      this.logger.info("Deposit transaction mined on L2. Checking status...");
      const watchdogTxResult = await this.getLastExecution(this.wallet.address);
      if (watchdogTxResult.status == null) {
        throw new Error(`Just executed deposit not found ${JSON.stringify(watchdogTxResult)}`);
      }
      this.recordDepositResult(watchdogTxResult);
      return watchdogTxResult.status;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.logger.error("watchdog deposit tx error: " + error?.message, error?.stack);
      this.metricRecorder.manualRecordStatus(Status.FAIL, 0);
      return Status.FAIL;
    }
  }

  public async run() {
    while (true) {
      const nextExecutionWait = timeoutPromise(this.intervalMs);
      const currentBlockchainTimestamp = await this.getCurrentChainTimestamp();
      const someDepositResult = await this.getLastExecution(void 0);
      // we only report OK. On fail we want perform a deposit manually as we cannot rely on users doing deposits properly
      let shouldPerformManualDeposit: boolean = true;
      if (someDepositResult.status === Status.OK) {
        this.recordDepositResult(someDepositResult);
        const timeSinceLastDeposit = currentBlockchainTimestamp - someDepositResult.timestampL1;
        if (timeSinceLastDeposit * SEC > this.txTriggerDelayMs) {
          this.logger.info(
            `Last users deposit was successful, but it was ${timeSinceLastDeposit} seconds ago. Will execute deposit tx manually.`
          );
        } else {
          shouldPerformManualDeposit = false;
        }
      }

      if (shouldPerformManualDeposit) {
        this.logger.info("Checking for last MANUAL deposit...");
        const lastOurExecution = await this.getLastExecution(this.wallet.address);
        // we take max with last onchain operation timestamp in case onchain operations are failing on L1 to avoid disrespecting retry limit
        const timeSinceLastOurDeposit =
          currentBlockchainTimestamp - Math.max(lastOurExecution.timestampL1, this.lastOnChainOperationTimestamp);
        if (timeSinceLastOurDeposit * SEC > this.txTriggerDelayMs) {
          this.logger.info("Starting manual deposit transaction");
          let attempt = 0;
          while (attempt < DEPOSIT_RETRY_LIMIT) {
            const result = await this.executeDepositTx();
            switch (result) {
              case Status.OK:
                this.logger.info(`attempt ${attempt + 1} succeeded`);
                break;
              case Status.SKIP:
                this.logger.info(`attempt ${attempt + 1} skipped. Not counting towards retry limit`);
                break;
              case Status.FAIL:
                this.logger.error(
                  `Deposit failed on try ${attempt + 1}/${DEPOSIT_RETRY_LIMIT}` +
                    (attempt + 1 != DEPOSIT_RETRY_LIMIT
                      ? `, retrying in ${(DEPOSIT_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                      : "")
                );
                attempt++;
                break;
              default: {
                const _impossible: never = result;
                throw new Error(`Unexpected result ${result}`);
              }
            }
            if (result === Status.OK) {
              break;
            }
            await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
          }
        } else {
          this.logger.info(
            `Last manual deposit was ${timeSinceLastOurDeposit} seconds ago. Reporting last status of ${lastOurExecution.status}`
          );
          if (lastOurExecution.status != null) this.recordDepositResult(lastOurExecution);
        }
      }

      await nextExecutionWait;
    }
  }
}
