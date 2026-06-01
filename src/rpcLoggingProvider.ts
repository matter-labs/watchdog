import { JsonRpcProvider } from "ethers";
import winston from "winston";

import type { JsonRpcApiProviderOptions, Networkish, TransactionReceipt } from "ethers";

const npmLevels = winston.config.npm.levels;
/** Whether the default winston logger would actually emit at `level`. */
const levelEnabled = (level: string): boolean => npmLevels[level] <= npmLevels[winston.level ?? "info"];

const bigintReplacer = (_: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

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

      // Guard the JSON.stringify: it runs on every RPC call and is otherwise
      // discarded by the level filter (prod runs at "info").
      if (levelEnabled("debug")) {
        winston.debug(`[JSON-RPC Request] ID: ${id} Method: ${method}`, {
          rpcRequest: { id, method, params: JSON.stringify(params, bigintReplacer) },
        });
      }

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
        // Log the full response result at a lower level to avoid cluttering logs, but still have it available for debugging when needed.
        // Stringifying every response is expensive (large RPC results), so only do it when silly logging is actually enabled.
        if (levelEnabled("silly")) {
          winston.silly(`[JSON-RPC Response Result] ID: ${id} Method: ${method}`, {
            rpcResponse: { id, method, result: JSON.stringify(result, bigintReplacer) },
          });
        }

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

      let timer: null | NodeJS.Timeout = null;
      let timedOut = false;
      const failIfTimedOut = () => {
        if (timedOut) {
          throw new Error("timeout");
        }
      };

      const pollLoop = async (): Promise<null | TransactionReceipt> => {
        const pollMs = this.pollingInterval;
        while (true) {
          failIfTimedOut();
          try {
            // Cheap inclusion probe: the raw JSON-RPC result is not parsed into ethers
            // objects, so no per-log address checksumming (keccak256) happens while
            // polling. The receipt is only formatted once, after it is confirmed.
            const raw = (await this.send("eth_getTransactionReceipt", [hash])) as { blockNumber?: string } | null;
            failIfTimedOut();
            if (raw?.blockNumber != null) {
              if (confirms <= 1) {
                const receipt = await this.getTransactionReceipt(hash);
                failIfTimedOut();
                return receipt;
              }
              const current = await this.getBlockNumber();
              failIfTimedOut();
              if (current - Number(raw.blockNumber) + 1 >= confirms) {
                const receipt = await this.getTransactionReceipt(hash);
                failIfTimedOut();
                return receipt;
              }
            }
          } catch (error) {
            if (timedOut) {
              throw error;
            }
            winston.error("Error in waitForTransaction", error);
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      };

      if (timeout == null) {
        return pollLoop();
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("timeout"));
        }, timeout);
      });

      try {
        return await Promise.race([pollLoop(), timeoutPromise]);
      } finally {
        timedOut = true;
        if (timer) {
          clearTimeout(timer);
        }
      }
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
