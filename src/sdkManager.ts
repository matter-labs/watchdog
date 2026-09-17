import { createEthersSdk } from "@matterlabs/zksync-js/ethers";

import type { EthersClient, EthersSdk } from "@matterlabs/zksync-js/ethers";

/**
 * Cached SDK data can become stale after protocol upgrades or retain failures from transient RPC errors.
 * Recreate the SDK after failed attempts so retries resolve fresh data.
 */
export interface SdkManager {
  get(): EthersSdk;
  reset(): void;
}

export function createSdkManager(
  getClient: () => EthersClient,
  createSdk: (client: EthersClient) => EthersSdk = createEthersSdk
): SdkManager {
  let sdk: EthersSdk | undefined;
  return {
    get() {
      sdk ??= createSdk(getClient());
      return sdk;
    },
    reset() {
      sdk = undefined;
      // Contract addresses can change across upgrades as well.
      getClient().refresh();
    },
  };
}
