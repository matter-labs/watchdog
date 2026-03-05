import { JsonRpcProvider } from "ethers";
import winston from "winston";

import type { JsonRpcApiProviderOptions, Networkish, TransactionReceipt } from "ethers";

/** Optional auth token getter for Prividium (Authorization: Bearer). */
export type AuthTokenGetter = () => string | null;

/**
 * Ethers JsonRpcProvider that can be given an auth token getter for Prividium.
 */
class AuthableEthersJsonRpcProvider extends JsonRpcProvider {
  declare readonly rpcUrl?: string;
  declare readonly walletAddress: string;
  getAuthToken?: AuthTokenGetter;

  constructor(walletAdddress: string, url?: string, network?: Networkish, options?: JsonRpcApiProviderOptions) {
    super(url, network, options);
    this.rpcUrl = url;
    this.walletAddress = walletAdddress;
  }

  setAuthTokenGetter(getter: AuthTokenGetter): void {
    this.getAuthToken = getter;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRpcUrl(provider: any): string | undefined {
  return provider.rpcUrl ?? provider._getConnection?.()?.url;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getWalletAddress(provider: any): string {
  return provider.walletAddress;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor<T = object> = new (...args: any[]) => T;

const LoggingProviderMixing = <TBase extends Ctor<JsonRpcProvider>>(Base: TBase) => {
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
          result = await sendAuthorizedRpcRequest(getWalletAddress(this), url, token, id, method, params);
        } else {
          result = await super.send(method, params);
        }

        const duration = Date.now() - startTime;
        winston.debug(`[JSON-RPC Response] ID: ${id} Method: ${method} Duration: ${duration}ms`, {
          rpcResponse: {
            id,
            method,
          },
        });
        // Log the full response result at a lower level to avoid cluttering logs, but still have it available for debugging when needed
        winston.silly(`[JSON-RPC Response Result] ID: ${id} Method: ${method}`, {
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
          try {
            if ((await receipt.confirmations()) >= confirms) {
              resolve(receipt);
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
            } else {
              await this.once(hash, listener);
            }
          } catch (error) {
            winston.error("Error in waitForTransaction", error);
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            reject(error);
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

function adjustParamsForPrividium(
  walletAddress: string,
  method: string,
  params: unknown[] | Record<string, unknown>
): unknown[] | Record<string, unknown> {
  if (Array.isArray(params) && params.length > 0) {
    // add default 'from' address to the `eth_call` request if not provided, to avoid Prividium
    // rejecting the request with `eth_call always has to specify from address` error.
    if (method === "eth_call") {
      if (params[0] !== null && typeof params[0] === "object") {
        return [
          {
            from: walletAddress,
            ...params[0],
          },
          ...(params.length > 1 ? params.slice(1) : []),
        ];
      }
    }
    // Remove `stateOverrides` from `eth_estimateGas` params to avoid Prividium rejecting
    // the request with `state overrides are not supported` error.
    if (method === "eth_estimateGas" && params.length > 2) {
      return [params[0], params[1]];
    }
  }
  return params;
}

async function sendAuthorizedRpcRequest(
  walletAddress: string,
  url: string,
  token: string,
  id: number,
  method: string,
  requestParams: unknown[] | Record<string, unknown>
) {
  const params = adjustParamsForPrividium(walletAddress, method, requestParams);

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

export const LoggingJsonRpcProvider = LoggingProviderMixing(AuthableEthersJsonRpcProvider);
