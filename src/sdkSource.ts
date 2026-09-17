import { createEthersSdk } from "@matterlabs/zksync-js/ethers";

import type { EthersClient, EthersSdk } from "@matterlabs/zksync-js/ethers";

/**
 * Hands out the zksync-js SDK and lets flows throw it away.
 *
 * The SDK detects the chain's withdrawal protocol (legacy `withdraw` vs. interop bundle) once per
 * instance and caches it forever, so after a protocol upgrade an SDK created before the upgrade keeps
 * building withdrawals for the old protocol until the process restarts. Flows call `reset()` when a
 * withdrawal fails; the next `current()` builds a fresh SDK that re-detects the protocol from L1.
 */
export interface SdkSource {
  current(): EthersSdk;
  reset(): void;
}

export function createSdkSource(
  getClient: () => EthersClient,
  createSdk: (client: EthersClient) => EthersSdk = createEthersSdk
): SdkSource {
  let sdk: EthersSdk | undefined;
  return {
    current() {
      sdk ??= createSdk(getClient());
      return sdk;
    },
    reset() {
      sdk = undefined;
      // drop cached contract addresses too; they are re-resolved together with the protocol
      getClient().refresh();
    },
  };
}
