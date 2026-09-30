import "dotenv/config";

import { ETH_ADDRESS } from "@matterlabs/zksync-js/core";
import { getL2TransactionHashFromLogs } from "@matterlabs/zksync-js/ethers";
import { formatEther, formatUnits, MaxInt256, parseEther, parseUnits } from "ethers";

import {
  DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI,
  DEPOSIT_RETRY_INTERVAL,
  DEPOSIT_RETRY_LIMIT,
  DepositBaseFlow,
  PRIORITY_OP_TIMEOUT,
  STEPS,
  getErc20Contract,
} from "./depositBase";
import {
  recordL1BaseTokenBalance,
  recordL1EthBalance,
  recordL2BaseTokenBalance,
  SkipReason,
  Status,
  StatusNoSkip,
} from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise, withTimeout } from "./utils";

import type { SdkManager } from "./sdkManager";
import type { WatchdogSigner } from "./wallet";
import type { DepositParams, ZKsyncError } from "@matterlabs/zksync-js/core";
import type { EthersClient } from "@matterlabs/zksync-js/ethers";
import type { JsonRpcProvider } from "ethers";

type Fee = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
/** Keep the L2 wallet funded from L1: below `min`, the deposit carries enough to bring it back to `target`. */
export type L2TopUp = { min: bigint; target: bigint };

const FLOW_NAME = "deposit";
const DEFAULT_MIN_PRIORITY_FEE_GWEI = "0.001";
const MIN_PRIORITY_FEE_ENV = "FLOW_DEPOSIT_L1_MIN_PRIORITY_FEE_GWEI";
const DEFAULT_FEE_BUMP_PERCENT = 10;
const FEE_BUMP_PERCENT_ENV = "FLOW_DEPOSIT_FEE_BUMP_PERCENT";
const L2_BALANCE_MIN_ENV = "FLOW_DEPOSIT_L2_BALANCE_MIN";
const L2_BALANCE_TARGET_ENV = "FLOW_DEPOSIT_L2_BALANCE_TARGET";

/** Reads the optional L2 top-up settings (amounts in ETH). Returns null when top-up is off. */
export function readL2TopUpConfig(env: NodeJS.ProcessEnv = process.env): L2TopUp | null {
  const min = env[L2_BALANCE_MIN_ENV];
  const target = env[L2_BALANCE_TARGET_ENV];
  if (!min && !target) return null;
  if (!min || !target) {
    throw new Error(`${L2_BALANCE_MIN_ENV} and ${L2_BALANCE_TARGET_ENV} must be set together`);
  }
  const config = { min: parseEther(min), target: parseEther(target) };
  if (config.min <= 0n || config.target < config.min) {
    throw new Error(`L2 top-up needs 0 < ${L2_BALANCE_MIN_ENV} <= ${L2_BALANCE_TARGET_ENV}, got ${min} and ${target}`);
  }
  return config;
}

function isUnderpricedError(e: ZKsyncError): boolean {
  return (e?.envelope?.cause as { code?: string })?.code === "REPLACEMENT_UNDERPRICED";
}

function maxOptionalBigInt(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a != null && b != null) return a > b ? a : b;
  return a ?? b;
}

export class DepositFlow extends DepositBaseFlow {
  private baseToken!: string;
  private readonly feeBumpPercent = +(process.env[FEE_BUMP_PERCENT_ENV] ?? DEFAULT_FEE_BUMP_PERCENT);
  private feeOverride: Fee | null = null;
  private l2TopUp: L2TopUp | null = readL2TopUpConfig();
  // Set while a deposit we sent may not have executed on L2 yet. Its funds would not show in the
  // L2 balance, so a top-up then would fund the wallet twice.
  private depositPending = false;

  constructor(
    wallet: WatchdogSigner,
    client: EthersClient,
    private sdkManager: SdkManager,
    intervalMs: number
  ) {
    super(wallet, client, FLOW_NAME, intervalMs);
  }

  private getMinPriorityFeePerGas(depositPriorityFee: bigint | null = null): bigint {
    const configuredValue = process.env[MIN_PRIORITY_FEE_ENV] ?? DEFAULT_MIN_PRIORITY_FEE_GWEI;
    const configuredMin = parseUnits(configuredValue, "gwei");
    if (depositPriorityFee == null || depositPriorityFee < configuredMin) {
      return configuredMin;
    }
    return depositPriorityFee;
  }

  private async computeBumpedFees(error: ZKsyncError): Promise<Fee | null> {
    const nonce = error.envelope.context?.nonce as number | undefined;
    let mempoolMaxFee: bigint | undefined;
    let mempoolPriorityFee: bigint | undefined;
    let txHash: string | undefined;

    // Step 1: fetch the pending tx from mempool and bump its fees
    if (nonce !== undefined) {
      try {
        type RpcTx = { hash: string; maxFeePerGas: string; maxPriorityFeePerGas: string } | null;
        // AbstractProvider doesn't expose send method, so casting to JsonRpcProvider.
        const pendingTx = (await (this.client.l1 as unknown as JsonRpcProvider).send(
          "eth_getTransactionBySenderAndNonce",
          [this.wallet.address, `0x${nonce.toString(16)}`]
        )) as RpcTx;
        if (pendingTx) {
          txHash = pendingTx.hash;
          mempoolMaxFee = (BigInt(pendingTx.maxFeePerGas) * BigInt(100 + this.feeBumpPercent)) / 100n;
          mempoolPriorityFee = (BigInt(pendingTx.maxPriorityFeePerGas) * BigInt(100 + this.feeBumpPercent)) / 100n;
        }
      } catch (rpcErr: unknown) {
        this.logger.error(`Failed to fetch pending tx for nonce ${nonce}: ${(rpcErr as Error)?.message}`);
      }
    }

    // Step 2: get SDK quote for current market fees (no bump — already reflects live market)
    let quoteMaxFee: bigint | undefined;
    let quotePriorityFee: bigint | undefined;
    try {
      const minPriorityFee = this.getMinPriorityFeePerGas();
      const quoteParams = {
        to: this.wallet.address,
        token: this.baseToken,
        amount: 1n,
        refundRecipient: this.wallet.address,
      } as DepositParams;
      const quote = await this.sdkManager.get().deposits.quote(quoteParams);
      quoteMaxFee = quote.fees.l1!.maxFeePerGas;
      quotePriorityFee = quote.fees.l1!.maxPriorityFeePerGas || minPriorityFee;
    } catch (quoteErr: unknown) {
      this.logger.error(`Failed to get fee estimate for underpriced retry: ${(quoteErr as Error)?.message}`);
    }

    const newMaxFee = maxOptionalBigInt(mempoolMaxFee, quoteMaxFee);
    const newPriorityFee = maxOptionalBigInt(mempoolPriorityFee, quotePriorityFee);

    if (newMaxFee != null && newPriorityFee != null) {
      this.logger.warn(
        `Deposit tx underpriced, new fees (bumped mempool +${this.feeBumpPercent}% vs SDK quote, taking max): ` +
          `txHash=${txHash ?? "unknown"}, ` +
          `maxFeePerGas=${formatUnits(newMaxFee, "gwei")} gwei, ` +
          `maxPriorityFeePerGas=${formatUnits(newPriorityFee, "gwei")} gwei`
      );
      return { maxFeePerGas: newMaxFee, maxPriorityFeePerGas: newPriorityFee };
    } else {
      this.logger.warn("Deposit tx underpriced but could not determine fees to bump, will retry");
      return null;
    }
  }

  /**
   * Amount that brings the L2 balance back to the top-up target, or null to deposit the usual 1 wei.
   * Needs a fresh L2 balance read, no deposit of ours still on its way to L2, and an L1 balance that
   * covers the amount plus `depositFees` (the L1 gas and L2 cost of a deposit, which do not depend on its amount).
   */
  private async l2TopUpAmount(l1EthBalance: bigint, depositFees: bigint): Promise<bigint | null> {
    if (!this.l2TopUp) return null;
    if (this.depositPending) {
      this.logger.info("L2 top-up: the previous deposit has not executed on L2 yet, depositing 1 wei");
      return null;
    }
    let l2Balance: bigint;
    try {
      l2Balance = await this.client.l2.getBalance(this.wallet.address);
    } catch (error: unknown) {
      this.logger.warn(`L2 top-up: cannot read the L2 balance, depositing 1 wei: ${(error as Error)?.message}`);
      return null;
    }
    recordL2BaseTokenBalance(l2Balance);
    const { min, target } = this.l2TopUp;
    if (l2Balance >= min) return null;

    const amount = target - l2Balance;
    const required = amount + depositFees;
    if (l1EthBalance < required) {
      this.logger.error(
        `L2 top-up: L2 balance ${formatEther(l2Balance)} is below ${formatEther(min)}, but the L1 balance ` +
          `${formatEther(l1EthBalance)} does not cover the ${formatEther(required)} needed, depositing 1 wei`
      );
      return null;
    }
    this.logger.info(
      `L2 top-up: L2 balance ${formatEther(l2Balance)} is below ${formatEther(min)}, ` +
        `depositing ${formatEther(amount)} to reach ${formatEther(target)}`
    );
    return amount;
  }

  protected async executeWatchdogDeposit(): Promise<Status> {
    try {
      const sdk = this.sdkManager.get();
      this.metricRecorder.recordFlowStart();

      if (this.baseToken != ETH_ADDRESS) {
        await this.metricRecorder.stepExecution({
          stepName: STEPS.base_token_approval,
          // both spenders can need an approval transaction, each with its own 3 minute wait
          stepTimeoutMs: 10 * MIN,
          fn: async () => {
            const { l1AssetRouter, l1NativeTokenVault } = await sdk.contracts.addresses();
            const erc20Contract = getErc20Contract(this.baseToken, this.client.l1, this.wallet);
            // The vault pulls tokens on upgraded bridges. Keep the router approval as well:
            // older bridges and the SDK's deposit planner still check its allowance.
            for (const spender of new Set([l1AssetRouter, l1NativeTokenVault])) {
              const allowance = await erc20Contract.allowance(this.wallet.address, spender);

              // heuristic condition to determine if we should perform the infinite approval
              if (allowance < parseEther("100000")) {
                this.logger.info(`Approving base token ${this.baseToken} for infinite amount to ${spender}`);
                const approval = await erc20Contract.approve(spender, MaxInt256);
                // Deposits use the latest mined nonce, so confirm the approval first.
                await withTimeout(approval.wait(1), 3 * MIN, `Base token approval for ${spender}`);
              } else {
                this.logger.info(`Base token ${this.baseToken} already has approval for ${spender}`);
              }
            }
            const baseTokenBalance = await erc20Contract.balanceOf(this.wallet.address);
            this.logger.info(`L1 base token (${this.baseToken}) balance: ${formatEther(baseTokenBalance.toString())}`);
            recordL1BaseTokenBalance(baseTokenBalance);
          },
        });
      }

      const l1EthBalance = await this.metricRecorder.stepExecution({
        stepName: STEPS.balance,
        stepTimeoutMs: 10 * SEC,
        fn: async () => {
          const l1EthBalance = await this.client.l1.getBalance(this.wallet.address);
          this.logger.info(`L1 ETH balance: ${formatEther(l1EthBalance.toString())}`);
          recordL1EthBalance(l1EthBalance);
          return l1EthBalance;
        },
      });

      const deposit = await this.metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 30 * SEC,
        fn: async ({ recordStepGas, recordStepGasCost, recordStepGasPrice }) => {
          let params = {
            to: this.wallet.address,
            token: this.baseToken,
            amount: 1n, // just 1 wei, unless the L2 balance needs a top-up
            refundRecipient: this.wallet.address,
          } as DepositParams;
          let depositQuote = await sdk.deposits.quote(params);
          // Quoting an amount the L1 balance cannot cover fails, so the 1 wei quote prices the top-up first.
          const topUp = await this.l2TopUpAmount(l1EthBalance, depositQuote.fees.maxTotal);
          if (topUp != null) {
            params = { ...params, amount: topUp };
            depositQuote = await sdk.deposits.quote(params);
          }
          recordStepGas(depositQuote.fees.l1!.gasLimit);
          recordStepGasPrice(depositQuote.fees.l1!.maxFeePerGas);
          recordStepGasCost(depositQuote.fees.l1!.maxTotal);

          return { params, quote: depositQuote };
        },
      });
      // record l2 estimates using the manual record function
      this.metricRecorder.manualRecordStepGas(STEPS.l2_estimation, unwrap(deposit.quote.fees.l2!.gasLimit));
      this.metricRecorder.manualRecordStepGasCost(STEPS.l2_estimation, unwrap(deposit.quote.fees.l2!.total));
      if (deposit.quote.fees.l1!.maxFeePerGas > DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI) {
        this.logger.warn(
          `Gas price ${deposit.quote.fees.l1!.maxFeePerGas} is higher than limit ${DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI}. Skipping deposit`
        );
        this.metricRecorder.recordFlowSkipped(SkipReason.L1_GAS_PRICE);
        return Status.SKIP;
      }

      // send L1 deposit transaction
      const { l1Tx, depositHandle } = await this.metricRecorder.stepExecution({
        stepName: STEPS.l1_execution,
        stepTimeoutMs: 3 * MIN,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          // Cleared only once the deposit executes on L2: until then its funds may be in flight.
          this.depositPending = true;
          const depositHandle = await sdk.deposits.create({
            ...deposit.params,
            l1TxOverrides: {
              nonce: "latest",
              ...(this.feeOverride || {
                maxPriorityFeePerGas: this.getMinPriorityFeePerGas(deposit.quote.fees.l1?.maxPriorityFeePerGas),
              }),
            },
          } as DepositParams);
          const txReceipt = await sdk.deposits.wait(depositHandle, { for: "l1" });
          recordStepGas(unwrap(txReceipt?.gasUsed));
          recordStepGasPrice(unwrap(txReceipt?.gasPrice));
          recordStepGasCost(unwrap(txReceipt?.gasUsed) * unwrap(txReceipt?.gasPrice));

          return { l1Tx: txReceipt, depositHandle };
        },
      }); // included in a block on L1

      const l2TxHash = getL2TransactionHashFromLogs(l1Tx!.logs);
      const txHashes = `(L1: ${l1Tx?.hash}, L2: ${l2TxHash})`;
      this.logger.info(`Tx ${txHashes} mined on l1`);

      // wait for deposit to be finalized
      await this.metricRecorder.stepExecution({
        stepName: STEPS.l2_execution,
        stepTimeoutMs: PRIORITY_OP_TIMEOUT,
        fn: async ({ recordStepGasPrice, recordStepGas, recordStepGasCost }) => {
          const receipt = unwrap(await sdk.deposits.wait(depositHandle, { for: "l2" }));
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasCost(unwrap(receipt.gasUsed) * unwrap(receipt.gasPrice));
          return receipt;
        },
      });
      this.depositPending = false;
      this.logger.info(`Tx ${txHashes} mined on L2`);
      this.metricRecorder.recordFlowSuccess();
      this.feeOverride = null;
      return Status.OK;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.sdkManager.reset();
      if (isUnderpricedError(error)) {
        this.feeOverride = await this.computeBumpedFees(error);
      } else {
        this.feeOverride = null;
        this.logger.error("deposit tx error: " + error?.message, error?.stack);
      }
      this.metricRecorder.recordFlowFailure();
      return Status.FAIL;
    }
  }

  protected async run(): Promise<void> {
    const { bridgehub, l1AssetRouter } = await this.sdkManager.get().contracts.instances();
    this.chainId = (await this.wallet.provider!.getNetwork()).chainId;
    this.baseToken = await this.client.baseToken(this.chainId);
    this.zkChainAddress = await bridgehub.getHyperchain(this.chainId);
    this.sharedBridge = l1AssetRouter;
    if (this.l2TopUp && this.baseToken != ETH_ADDRESS) {
      this.logger.error(`L2 top-up supports ETH-based chains only, base token is ${this.baseToken}: top-up disabled`);
      this.l2TopUp = null;
    }

    const lastExecution = await this.getLastExecution(this.wallet.address);
    // A deposit sent before a restart that has not executed on L2 blocks top-ups like one sent by this run.
    this.depositPending = lastExecution.status === StatusNoSkip.FAIL;
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
            this.logger.warn(
              `[deposit] attempt ${attempt} of ${DEPOSIT_RETRY_LIMIT} failed` +
                (attempt < DEPOSIT_RETRY_LIMIT
                  ? `, retrying in ${(DEPOSIT_RETRY_INTERVAL / 1000).toFixed(0)} seconds`
                  : "")
            );
            attempt++;
            await timeoutPromise(DEPOSIT_RETRY_INTERVAL);
            break;
          }
          default: {
            const _exhaustiveCheck: never = result;
            throw new Error(`Unreachable code branch: ${_exhaustiveCheck}`);
          }
        }
        if (result === Status.OK || result === Status.SKIP) break;
      }
      await nextExecutionWait;
    }
  }
}
