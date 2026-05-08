import { KeyManagementServiceClient } from "@google-cloud/kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createPublicKey } from "crypto";
import {
  AbstractSigner,
  computeAddress,
  getBytes,
  hashMessage,
  keccak256,
  recoverAddress,
  Signature,
  Transaction,
  TypedDataEncoder,
} from "ethers";
import winston from "winston";

import type { Provider, TransactionRequest, TypedDataDomain, TypedDataField } from "ethers";

/**
 * An ethers.js v6 Signer backed by Google Cloud KMS.
 *
 * Expects a KMS resource name of the form:
 *   projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{key}/cryptoKeyVersions/{version}
 *
 * The key **must** be an EC_SIGN_SECP256K1_SHA256 key.
 *
 * Authentication uses Application Default Credentials (ADC), which in GKE is
 * typically injected via Workload Identity / Workload Identity Federation.
 */
export class GcpKmsSigner extends AbstractSigner {
  /** Resolved Ethereum address (checksummed). Set by {@link init}. */
  public address!: string;

  protected readonly kmsClient: KeyManagementServiceClient;
  protected readonly keyVersionName: string;

  /**
   * Use the static {@link create} factory instead of calling the constructor
   * directly — it awaits the async KMS public-key lookup that populates
   * `this.address`.
   */
  constructor(keyVersionName: string, provider?: Provider | null, kmsClient?: KeyManagementServiceClient) {
    super(provider ?? null);
    this.keyVersionName = keyVersionName;
    this.kmsClient = kmsClient ?? new KeyManagementServiceClient();
  }

  /* ------------------------------------------------------------------ */
  /*  Factory                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Create and fully initialise a GcpKmsSigner.
   * The returned instance already has its `address` resolved from KMS.
   */
  static async create(keyVersionName: string, provider?: Provider | null): Promise<GcpKmsSigner> {
    const signer = new GcpKmsSigner(keyVersionName, provider);
    await signer.init();
    return signer;
  }

  /* ------------------------------------------------------------------ */
  /*  Initialisation                                                     */
  /* ------------------------------------------------------------------ */

  /** Fetch the public key from KMS and derive the Ethereum address. */
  private async init(): Promise<void> {
    const [publicKey] = await this.kmsClient.getPublicKey({ name: this.keyVersionName });

    if (!publicKey.pem) {
      throw new Error("GCP KMS did not return a PEM public key");
    }
    if (publicKey.algorithm !== "EC_SIGN_SECP256K1_SHA256") {
      throw new Error(`GCP KMS key algorithm must be EC_SIGN_SECP256K1_SHA256, got ${publicKey.algorithm}`);
    }

    const uncompressedPubKey = pemToUncompressedPublicKey(publicKey.pem);
    this.address = computeAddress(uncompressedPubKey);
    winston.info(`GCP KMS signer initialised: address=${this.address}, key=${this.keyVersionName}`);
  }

  /* ------------------------------------------------------------------ */
  /*  AbstractSigner implementation                                      */
  /* ------------------------------------------------------------------ */

  async getAddress(): Promise<string> {
    return this.address;
  }

  connect(provider: Provider): GcpKmsSigner {
    return new ConnectedGcpKmsSigner(this.keyVersionName, this.address, this.kmsClient, provider);
  }

  async signTransaction(txRequest: TransactionRequest): Promise<string> {
    const tx = Transaction.from(txRequest as Parameters<typeof Transaction.from>[0]);
    const unsignedSerialized = tx.unsignedSerialized;
    const digest = keccak256(unsignedSerialized);

    const sig = await this.kmsSign(getBytes(digest));
    tx.signature = sig;
    return tx.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const digest = hashMessage(message);
    const sig = await this.kmsSign(getBytes(digest));
    return Signature.from(sig).serialized;
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string> {
    const digest = TypedDataEncoder.hash(domain, types, value);
    const sig = await this.kmsSign(getBytes(digest));
    return Signature.from(sig).serialized;
  }

  /* ------------------------------------------------------------------ */
  /*  KMS signing helpers                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Sign a 32-byte digest via GCP KMS and return an ethers {@link Signature}
   * with the recovery parameter `v` resolved.
   */
  private async kmsSign(digest: Uint8Array): Promise<Signature> {
    // Pass the pre-computed digest via `digest.sha256` so KMS signs it
    // directly without applying an additional SHA-256 round.
    const [response] = await this.kmsClient.asymmetricSign({
      name: this.keyVersionName,
      digest: { sha256: digest },
    });

    if (!response.signature) {
      throw new Error("GCP KMS asymmetricSign returned no signature");
    }

    const sigBytes =
      response.signature instanceof Uint8Array
        ? response.signature
        : new Uint8Array(Buffer.from(response.signature as string, "base64"));

    // fromDER parses the DER-encoded signature; normalizeS enforces low-S (EIP-2)
    const { r, s } = secp256k1.Signature.fromDER(sigBytes).normalizeS();

    const digestHex = "0x" + Buffer.from(digest).toString("hex");
    const rHex = "0x" + r.toString(16).padStart(64, "0");
    const sHex = "0x" + s.toString(16).padStart(64, "0");

    for (const v of [27, 28]) {
      const candidate = Signature.from({ r: rHex, s: sHex, v });
      const recovered = recoverAddress(digestHex, candidate);
      if (recovered.toLowerCase() === this.address.toLowerCase()) {
        return candidate;
      }
    }

    throw new Error("GCP KMS: could not determine recovery parameter (v) for signature");
  }
}

/* ------------------------------------------------------------------ */
/*  Internal subclass for connected signers                            */
/* ------------------------------------------------------------------ */

/**
 * A GcpKmsSigner that was produced by {@link GcpKmsSigner.connect}.
 * It re-uses the already-resolved address and KMS client from the parent
 * so no additional KMS calls are needed.
 */
class ConnectedGcpKmsSigner extends GcpKmsSigner {
  constructor(
    keyVersionName: string,
    resolvedAddress: string,
    kmsClient: KeyManagementServiceClient,
    provider: Provider
  ) {
    // Pass the existing kmsClient to avoid creating a new one
    super(keyVersionName, provider, kmsClient);
    this.address = resolvedAddress;
  }
}

/* ------------------------------------------------------------------ */
/*  PEM utility                                                        */
/* ------------------------------------------------------------------ */

function pemToUncompressedPublicKey(pem: string): string {
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return "0x04" + x.toString("hex") + y.toString("hex");
}
