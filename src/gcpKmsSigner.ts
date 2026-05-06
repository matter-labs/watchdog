import { KeyManagementServiceClient } from "@google-cloud/kms";
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
      throw new Error(
        `GCP KMS key algorithm must be EC_SIGN_SECP256K1_SHA256, got ${publicKey.algorithm}`
      );
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
    const [response] = await this.kmsClient.asymmetricSign({
      name: this.keyVersionName,
      data: digest,
    });

    if (!response.signature) {
      throw new Error("GCP KMS asymmetricSign returned no signature");
    }

    const sigBytes =
      response.signature instanceof Uint8Array
        ? response.signature
        : new Uint8Array(Buffer.from(response.signature as string, "base64"));

    const { r, s } = parseDerSignature(sigBytes);

    // secp256k1 order — needed to normalise `s` to low-S form (EIP-2)
    const secp256k1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sNorm = s > secp256k1N / 2n ? secp256k1N - s : s;

    // Determine recovery parameter by trying both values
    const digestHex = "0x" + Buffer.from(digest).toString("hex");
    const rHex = "0x" + r.toString(16).padStart(64, "0");
    const sHex = "0x" + sNorm.toString(16).padStart(64, "0");

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
/*  DER / PEM utilities                                                */
/* ------------------------------------------------------------------ */

/**
 * Extract the uncompressed secp256k1 public key (0x04 || x || y, 65 bytes)
 * from a PEM-encoded SubjectPublicKeyInfo structure returned by GCP KMS.
 */
function pemToUncompressedPublicKey(pem: string): string {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(base64, "base64");

  // The DER-encoded SubjectPublicKeyInfo for secp256k1 contains a 65-byte
  // uncompressed point (0x04 prefix) at the very end.
  // Walk through ASN.1 to find the BIT STRING payload.
  const pubKeyBytes = extractBitStringPayload(der);
  if (pubKeyBytes.length !== 65 || pubKeyBytes[0] !== 0x04) {
    throw new Error(`Unexpected public key format from KMS (length=${pubKeyBytes.length})`);
  }
  return "0x" + Buffer.from(pubKeyBytes).toString("hex");
}

/**
 * Parse a DER-encoded ECDSA signature and return (r, s) as bigints.
 *
 * DER layout:
 *   SEQUENCE { INTEGER r, INTEGER s }
 *   30 <len> 02 <rLen> <r…> 02 <sLen> <s…>
 */
function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 0;

  // SEQUENCE tag
  if (der[offset++] !== 0x30) throw new Error("DER: expected SEQUENCE tag");
  offset += derReadLengthBytes(der, offset);

  // INTEGER r
  if (der[offset++] !== 0x02) throw new Error("DER: expected INTEGER tag for r");
  const rLen = der[offset++];
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;

  // INTEGER s
  if (der[offset++] !== 0x02) throw new Error("DER: expected INTEGER tag for s");
  const sLen = der[offset++];
  const sBytes = der.slice(offset, offset + sLen);

  return {
    r: BigInt("0x" + Buffer.from(rBytes).toString("hex")),
    s: BigInt("0x" + Buffer.from(sBytes).toString("hex")),
  };
}

/** Advance past a DER length field and return how many bytes were consumed. */
function derReadLengthBytes(buf: Uint8Array, offset: number): number {
  if (buf[offset] < 0x80) return 1;
  const numBytes = buf[offset] & 0x7f;
  return 1 + numBytes;
}

/**
 * Walk a DER-encoded SubjectPublicKeyInfo to find the BIT STRING payload
 * (the raw public key bytes, minus the leading "unused bits" octet).
 */
function extractBitStringPayload(der: Buffer): Uint8Array {
  let offset = 0;

  // outer SEQUENCE
  if (der[offset++] !== 0x30) throw new Error("SPKI: expected SEQUENCE");
  offset += derReadLengthBytes(der, offset);

  // algorithm identifier SEQUENCE — skip entirely
  if (der[offset] !== 0x30) throw new Error("SPKI: expected algorithm SEQUENCE");
  offset++; // tag
  const algoLen = derReadLength(der, offset);
  offset += derLengthFieldSize(der, offset) + algoLen;

  // BIT STRING
  if (der[offset++] !== 0x03) throw new Error("SPKI: expected BIT STRING");
  const bsLen = derReadLength(der, offset);
  offset += derLengthFieldSize(der, offset);

  // first byte of BIT STRING content is "unused bits count", should be 0
  const unusedBits = der[offset++];
  if (unusedBits !== 0) throw new Error("SPKI: expected 0 unused bits in BIT STRING");

  return der.slice(offset, offset + bsLen - 1);
}

function derReadLength(buf: Buffer, offset: number): number {
  if (buf[offset] < 0x80) return buf[offset];
  const numBytes = buf[offset] & 0x7f;
  let length = 0;
  for (let i = 1; i <= numBytes; i++) {
    length = (length << 8) | buf[offset + i];
  }
  return length;
}

function derLengthFieldSize(buf: Buffer, offset: number): number {
  if (buf[offset] < 0x80) return 1;
  return 1 + (buf[offset] & 0x7f);
}
