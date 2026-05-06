import { Wallet as EthersWallet } from "ethers";
import winston from "winston";

import { GcpKmsSigner } from "./gcpKmsSigner";

import type { AbstractSigner, Provider } from "ethers";

/**
 * Union type for signers used throughout the watchdog.
 * Both branches expose an `address` property and the full AbstractSigner API.
 */
export type WatchdogSigner = (EthersWallet | GcpKmsSigner) & AbstractSigner & { address: string };

/** Returns true when the key looks like a GCP KMS resource name. */
export function isGcpKmsKey(key: string): boolean {
  return key.startsWith("projects/");
}

/**
 * Create a signer from a WALLET_KEY value.
 *
 * - If the key starts with `projects/` it is treated as a GCP KMS
 *   CryptoKeyVersion resource name and a {@link GcpKmsSigner} is returned.
 *   Authentication uses Application Default Credentials (Workload Identity).
 *
 * - Otherwise it is treated as a hex-encoded private key and a standard
 *   ethers {@link EthersWallet} is returned.
 *
 * @param key       Raw WALLET_KEY value (hex string *or* KMS resource name).
 * @param provider  Optional provider to connect the signer to.
 */
export async function createWallet(key: string, provider?: Provider | null): Promise<WatchdogSigner> {
  if (isGcpKmsKey(key)) {
    winston.info("WALLET_KEY is a GCP KMS resource name — using KMS signer");
    const signer = await GcpKmsSigner.create(key, provider);
    return signer as WatchdogSigner;
  }

  winston.info("WALLET_KEY is a hex private key — using local wallet");
  const wallet = provider ? new EthersWallet(key, provider) : new EthersWallet(key);
  return wallet as WatchdogSigner;
}
