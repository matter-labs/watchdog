import { JsonRpcProvider as EthersJsonRpcProvider } from "ethers";
import winston from "winston";
import { Provider as ZkSyncProvider } from "zksync-ethers";
import { IBridgehub__factory } from "zksync-ethers/build/typechain";

import type { Networkish, Provider as EthersProvider, TransactionReceipt } from "ethers";
import type { Fee, TransactionRequest } from "zksync-ethers/build/types";

/** Optional auth token getter for Prividium (Authorization: Bearer). */
export type AuthTokenGetter = () => string | null;

/**
 * Ethers JsonRpcProvider that can be given an auth token getter for Prividium.
 */
class AuthableEthersJsonRpcProvider extends EthersJsonRpcProvider {
  declare readonly rpcUrl?: string;
  getAuthToken?: AuthTokenGetter;

  constructor(url?: string, network?: Networkish) {
    super(url, network);
    this.rpcUrl = url;
  }

  setAuthTokenGetter(getter: AuthTokenGetter): void {
    this.getAuthToken = getter;
  }
}

/**
 * Custom Provider wrapper that logs all JSON-RPC calls
 */
class ZkSyncOsProvider extends ZkSyncProvider {
  private l1Provider: EthersProvider | null = null;
  private isZKsyncOS = false;
  protected readonly rpcUrl: string;
  getAuthToken?: AuthTokenGetter;

  constructor(url: string) {
    super(url);
    this.rpcUrl = url;
  }

  setAuthTokenGetter(getter: AuthTokenGetter): void {
    this.getAuthToken = getter;
  }

  setIsZKsyncOS(isZKsyncOS: boolean) {
    this.isZKsyncOS = isZKsyncOS;
  }

  setL1Provider(l1Provider: EthersProvider) {
    this.l1Provider = l1Provider;
  }

  /// method overriden to use L1 calls instead of zks_ method for compatibility with ZKsync OS
  override async getBaseTokenContractAddress(): Promise<string> {
    const bridgehubAddress = await this.getBridgehubContractAddress();
    const bridgehub = IBridgehub__factory.connect(bridgehubAddress, this.l1Provider);
    const chainId = (await this.getNetwork()).chainId;
    return await bridgehub.baseToken(chainId);
  }

  override async estimateFee(transaction: TransactionRequest): Promise<Fee> {
    if (!this.isZKsyncOS) {
      return super.estimateFee(transaction);
    } else {
      const gasPrice = await this.getGasPrice();
      return {
        gasLimit: 0n, // return smth, it shouldn't be used
        gasPerPubdataLimit: 1n,
        maxPriorityFeePerGas: 0n,
        maxFeePerGas: gasPrice * 2n,
      };
    }
  }

  /**
   * Override send method to intercept and log JSON-RPC calls
   */
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRpcUrl(provider: any): string | undefined {
  return provider.rpcUrl ?? provider._getConnection?.()?.url;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor<T = object> = new (...args: any[]) => T;

const LoggingProviderMixing = <TBase extends Ctor<EthersJsonRpcProvider>>(Base: TBase) => {
  return class LoggingProvider extends Base {
    private requestId: number = 1;

    override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
      const id = this.requestId++;
      const self = this as typeof this & { getAuthToken?: AuthTokenGetter };

      winston.debug(`[JSON-RPC Request] ID: ${id} Method: ${method}`, {
        rpcRequest: {
          id,
          method,
          params: JSON.stringify(params, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
        },
      });

      const startTime = Date.now();
      try {
        let result: unknown;
        const token = self.getAuthToken?.();

        const url = getRpcUrl(self);

        if (token && url) {
          result = await sendAuthorizedRpcRequest(url, token, id, method, params);
        } else {
          result = await super.send(method, params);
        }

        const duration = Date.now() - startTime;
        winston.debug(`[JSON-RPC Response] ID: ${id} Method: ${method} Duration: ${duration}ms`, {
          rpcResponse: {
            id,
            method,
            result: JSON.stringify(result, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
          },
        });

        return result;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        const duration = Date.now() - startTime;

        winston.error(`[JSON-RPC Error] ID: ${id} Method: ${method} Duration: ${duration}ms Error: ${error.message}`, {
          rpcError: {
            id,
            method,
            error: error.message,
            code: error.code,
            data: error.data,
          },
        });

        throw error;
      }
    }

    override async waitForTransaction(
      hash: string,
      _confirms?: null | number,
      timeout?: null | number
    ): Promise<null | TransactionReceipt> {
      const confirms = _confirms != null ? _confirms : 1;
      if (confirms === 0) {
        return this.getTransactionReceipt(hash);
      }

      return new Promise((resolve, reject) => {
        let timer: null | NodeJS.Timeout = null;

        const listener = async (receipt: TransactionReceipt) => {
          await this.once(hash, listener);
          try {
            if ((await receipt.confirmations()) >= confirms) {
              resolve(receipt);
              await this.off(hash, listener);
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              return;
            }
          } catch (error) {
            winston.error("Error in waitForTransaction", error);
          }
        };

        if (timeout != null) {
          timer = setTimeout(() => {
            if (timer == null) {
              return;
            }
            timer = null;
            this.off(hash, listener);
            reject(new Error("timeout"));
          }, timeout);
        }

        this.once(hash, listener);
      });
    }
  };
};

async function sendAuthorizedRpcRequest(
  url: string,
  token: string,
  id: number,
  method: string,
  params: unknown[] | Record<string, unknown>
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: Array.isArray(params) ? params : params === undefined ? [] : [params],
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const data = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  if (!res.ok || data.error) {
    const err = new Error(data.error?.message ?? `RPC ${res.status}`) as Error & {
      code?: number;
      data?: unknown;
    };
    err.code = data.error?.code;
    err.data = data.error;
    throw err;
  }
  return data.result;
}

export const LoggingZkSyncProvider = LoggingProviderMixing(ZkSyncOsProvider);
export const LoggingEthersJsonRpcProvider = LoggingProviderMixing(AuthableEthersJsonRpcProvider);
