import "dotenv/config";

import { ETH_ADDRESS } from "@matterlabs/zksync-js/core";
import { getL2TransactionHashFromLogs } from "@matterlabs/zksync-js/ethers";
import { formatEther, formatUnits, MaxInt256, MaxUint256, parseUnits } from "ethers";

import {
  DEPOSIT_L1_GAS_PRICE_LIMIT_GWEI,
  DEPOSIT_RETRY_INTERVAL,
  DEPOSIT_RETRY_LIMIT,
  DepositBaseFlow,
  PRIORITY_OP_TIMEOUT,
  STEPS,
  getErc20Contract,
} from "./depositBase";
import { recordL1BaseTokenBalance, recordL1EthBalance, SkipReason, Status } from "./flowMetric";
import { SEC, MIN, unwrap, timeoutPromise, withTimeout } from "./utils";

import type { SdkManager } from "./sdkManager";
import type { WatchdogSigner } from "./wallet";
import type { DepositParams, DepositWaitable, ZKsyncError } from "@matterlabs/zksync-js/core";
import type { EthersClient, EthersSdk } from "@matterlabs/zksync-js/ethers";
import type { JsonRpcProvider } from "ethers";

type Fee = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
type DepositRun = { handle?: DepositWaitable; feeOverride?: Fee };

const FLOW_NAME = "deposit";
const DEFAULT_MIN_PRIORITY_FEE_GWEI = "0.001";
const MIN_PRIORITY_FEE_ENV = "FLOW_DEPOSIT_L1_MIN_PRIORITY_FEE_GWEI";
const DEFAULT_FEE_BUMP_PERCENT = 10;
const FEE_BUMP_PERCENT_ENV = "FLOW_DEPOSIT_FEE_BUMP_PERCENT";

function isUnderpricedError(e: ZKsyncError): boolean {
  return (e?.envelope?.cause as { code?: string })?.code === "REPLACEMENT_UNDERPRICED";
}

function maxOptionalBigInt(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a != null && b != null) return a > b ? a : b;
  return a ?? b;
}

export class DepositFlow extends DepositBaseFlow {
  private baseToken!: string;
  private readonly amount: bigint;
  private readonly feeBumpPercent = +(process.env[FEE_BUMP_PERCENT_ENV] ?? DEFAULT_FEE_BUMP_PERCENT);

  constructor(
    wallet: WatchdogSigner,
    client: EthersClient,
    private sdkManager: SdkManager,
    intervalMs: number
  ) {
    super(wallet, client, FLOW_NAME, intervalMs);
    const raw = process.env.FLOW_DEPOSIT_AMOUNT_WEI ?? "1";
    this.amount = /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    if (this.amount === 0n || this.amount > MaxUint256) {
      throw new Error("FLOW_DEPOSIT_AMOUNT_WEI must be a positive decimal uint256");
    }
  }

  private getMinPriorityFeePerGas(depositPriorityFee: bigint | null = null): bigint {
    const configuredValue = process.env[MIN_PRIORITY_FEE_ENV] ?? DEFAULT_MIN_PRIORITY_FEE_GWEI;
    const configuredMin = parseUnits(configuredValue, "gwei");
    if (depositPriorityFee == null || depositPriorityFee < configuredMin) {
      return configuredMin;
    }
    return depositPriorityFee;
  }

  private async computeBumpedFees(error: ZKsyncError): Promise<Fee | undefined> {
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
        amount: this.amount,
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
      return undefined;
    }
  }

  protected async executeWatchdogDeposit(run: DepositRun = {}): Promise<Status | "submission-unknown"> {
    let creating = false;
    try {
      const sdk = this.sdkManager.get();
      this.metricRecorder.recordFlowStart();
      if (run.handle) return this.confirmDeposit(sdk, run.handle);

      const approveBaseToken = async (required: bigint) => {
        await this.metricRecorder.stepExecution({
          stepName: STEPS.base_token_approval,
          // both spenders can need an approval transaction, each with its own 3 minute wait
          stepTimeoutMs: 10 * MIN,
          fn: async () => {
            const { l1AssetRouter, l1NativeTokenVault } = await sdk.contracts.addresses();
            const erc20Contract = getErc20Contract(this.baseToken, this.client.l1, this.wallet);
            // The vault pulls tokens on upgraded bridges. Keep the router approval as well:
            // older bridges still use the router allowance.
            for (const spender of new Set([l1AssetRouter, l1NativeTokenVault])) {
              const allowance = await erc20Contract.allowance(this.wallet.address, spender);

              if (allowance < required) {
                this.logger.info(`Approving base token ${this.baseToken} for infinite amount to ${spender}`);
                const approval = await erc20Contract.approve(spender, required > MaxInt256 ? MaxUint256 : MaxInt256);
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
      };

      await this.metricRecorder.stepExecution({
        stepName: STEPS.balance,
        stepTimeoutMs: 10 * SEC,
        fn: async () => {
          const l1EthBalance = await this.client.l1.getBalance(this.wallet.address);
          this.logger.info(`L1 ETH balance: ${formatEther(l1EthBalance.toString())}`);
          recordL1EthBalance(l1EthBalance);
        },
      });

      const deposit = await this.metricRecorder.stepExecution({
        stepName: STEPS.estimation,
        stepTimeoutMs: 30 * SEC,
        fn: async ({ recordStepGas, recordStepGasCost, recordStepGasPrice }) => {
          const fees = run.feeOverride ?? {
            maxPriorityFeePerGas: this.getMinPriorityFeePerGas(
              (await this.client.l1.getFeeData()).maxPriorityFeePerGas
            ),
          };
          const params = {
            to: this.wallet.address,
            token: this.baseToken,
            amount: this.amount,
            refundRecipient: this.wallet.address,
            l1TxOverrides: { nonce: "latest", ...fees },
          } as DepositParams;
          const depositQuote = await sdk.deposits.quote(params);
          // Keep the fee used to price the bridge mint value when create() rebuilds the quote.
          params.l1TxOverrides!.maxFeePerGas = depositQuote.fees.l1!.maxFeePerGas;
          recordStepGas(depositQuote.fees.l1!.gasLimit);
          recordStepGasPrice(depositQuote.fees.l1!.maxFeePerGas);
          recordStepGasCost(depositQuote.fees.l1!.maxTotal);

          return { params, quote: depositQuote };
        },
      });

      if (this.baseToken !== ETH_ADDRESS) {
        await approveBaseToken(unwrap(deposit.quote.fees.mintValue, "deposit mint value"));
      }
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

      creating = true;
      run.handle = await this.metricRecorder.stepExecution({
        stepName: STEPS.send,
        stepTimeoutMs: 3 * MIN,
        fn: () => sdk.deposits.create(deposit.params),
      });
      return this.confirmDeposit(sdk, run.handle);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.sdkManager.reset();
      this.metricRecorder.recordFlowFailure();
      if (isUnderpricedError(error)) {
        run.feeOverride = await this.computeBumpedFees(error);
      } else {
        run.feeOverride = undefined;
        this.logger.error("deposit tx error: " + error?.message, error?.stack);
        if (creating) {
          const context = error?.envelope?.context;
          if (!context?.step?.startsWith("bridgehub:") || !context.txHash) return "submission-unknown";
          run.handle = context.txHash;
        }
      }
      return Status.FAIL;
    }
  }

  private async confirmDeposit(sdk: EthersSdk, depositHandle: DepositWaitable): Promise<Status> {
    try {
      const l1Tx = await this.metricRecorder.stepExecution({
        stepName: STEPS.l1_execution,
        stepTimeoutMs: 3 * MIN,
        fn: async ({ recordStepGas, recordStepGasPrice, recordStepGasCost }) => {
          const txReceipt = await sdk.deposits.wait(depositHandle, { for: "l1" });
          if (txReceipt?.status === 0) throw new Error(`Deposit reverted on L1: ${txReceipt.hash}`);
          recordStepGas(unwrap(txReceipt?.gasUsed));
          recordStepGasPrice(unwrap(txReceipt?.gasPrice));
          recordStepGasCost(unwrap(txReceipt?.gasUsed) * unwrap(txReceipt?.gasPrice));

          return txReceipt;
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
          if (receipt.status === 0) throw new Error(`Deposit reverted on L2: ${receipt.hash}`);
          recordStepGasPrice(unwrap(receipt.gasPrice));
          recordStepGas(unwrap(receipt.gasUsed));
          recordStepGasCost(unwrap(receipt.gasUsed) * unwrap(receipt.gasPrice));
          return receipt;
        },
      });
      this.logger.info(`Tx ${txHashes} mined on L2`);
      this.metricRecorder.recordFlowSuccess();
      return Status.OK;
    } catch (error) {
      this.sdkManager.reset();
      this.logger.error("Deposit confirmation failed", error);
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
      const run: DepositRun = {};
      let attempt: number = 1;
      while (attempt <= DEPOSIT_RETRY_LIMIT) {
        const result = await this.executeWatchdogDeposit(run);
        if (result === "submission-unknown") {
          this.logger.warn("Deposit submission outcome unknown, ending this scheduled run");
          break;
        }
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
