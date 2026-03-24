import winston from "winston";

import type { Signer } from "ethers";

/** Shared mutable container for the current Prividium auth token. */
export interface PrividiumTokenStore {
  token: string | null;
}

export interface SiweMessageResponse {
  msg: string;
  nonceToken?: string;
}

/** Response from Prividium verify endpoint; adapt to actual API shape. */
export interface SiweVerifyResponse {
  token?: string;
  accessToken?: string;
  access_token?: string;
}

/**
 * Runs the full SIWE flow: get message from API, sign with wallet, verify and obtain auth token.
 * If a token store is provided, it will be updated with the new token.
 * Use this token in Authorization header for all Prividium RPC and API calls.
 */
export async function runSiweFlow(
  signer: Signer,
  apiUrl: string,
  domain: string,
  tokenStore: PrividiumTokenStore
): Promise<string> {
  const address = await signer.getAddress();

  const messageRes = await fetch(`${apiUrl}/api/siwe-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ address, domain }),
  });

  if (!messageRes.ok) {
    throw new Error(`SIWE message request failed: ${messageRes.status} ${await messageRes.text()}`);
  }

  const messageData = (await messageRes.json()) as SiweMessageResponse;
  if (!messageData.msg) {
    throw new Error("SIWE response missing msg");
  }

  const signature = await signer.signMessage(messageData.msg);

  const verifyRes = await fetch(`${apiUrl}/api/auth/login/crypto-native`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // The `nonceToken` is only present for Prividium v1.165.0+.
    // It will be omitted for older versions as it is not returned in prior versions.
    body: JSON.stringify({ message: messageData.msg, signature, nonceToken: messageData.nonceToken }),
  });

  if (!verifyRes.ok) {
    throw new Error(`SIWE verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }

  const verifyData = (await verifyRes.json()) as SiweVerifyResponse;
  const token = verifyData.token ?? verifyData.accessToken ?? verifyData.access_token ?? null;
  if (!token || typeof token !== "string") {
    throw new Error("SIWE verify response missing token (expected token, accessToken, or access_token)");
  }

  tokenStore.token = token;

  winston.info("Prividium SIWE flow completed; auth token set");
  return token;
}
