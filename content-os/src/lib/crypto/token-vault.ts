import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-layer envelope for third-party OAuth tokens.
 *
 *   ciphertext format:  v<keyVersion>:<iv b64url>:<authTag b64url>:<data b64url>
 *
 * AES-256-GCM with a random 96-bit IV per encryption. The key never reaches the
 * database; a database dump alone does not reveal tokens. Keys are versioned so
 * they can be rotated: decrypt with the version embedded in the ciphertext,
 * encrypt with the current version. `aad` binds a ciphertext to its owner (we
 * use the workspace id) so a ciphertext copied to another row will not decrypt.
 */
export type KeyResolver = (version: number) => string | undefined;

function loadKey(resolve: KeyResolver, version: number): Buffer {
  const b64 = resolve(version);
  if (!b64) throw new Error(`Encryption key version ${version} is not configured`);
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`Encryption key version ${version} must be 32 bytes (base64)`);
  return key;
}

export function encryptToken(plaintext: string, opts: { resolve: KeyResolver; version: number; aad: string }): string {
  const key = loadKey(opts.resolve, opts.version);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v" + opts.version, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

export function decryptToken(payload: string, opts: { resolve: KeyResolver; aad: string }): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || !/^v\d+$/.test(parts[0]!)) throw new Error("Malformed ciphertext");
  const [v, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const key = loadKey(opts.resolve, Number(v.slice(1)));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(opts.aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

export function keyVersionOf(payload: string): number {
  const m = /^v(\d+):/.exec(payload);
  if (!m) throw new Error("Malformed ciphertext");
  return Number(m[1]);
}
