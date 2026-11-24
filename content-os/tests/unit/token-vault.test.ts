import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, keyVersionOf } from "@/lib/crypto/token-vault";

const keys: Record<number, string> = { 1: randomBytes(32).toString("base64"), 2: randomBytes(32).toString("base64") };
const resolve = (v: number) => keys[v];

describe("token vault (AES-256-GCM)", () => {
  it("round-trips a token", () => {
    const c = encryptToken("IGQV-secret-token", { resolve, version: 1, aad: "ws-1" });
    expect(c).not.toContain("IGQV");
    expect(decryptToken(c, { resolve, aad: "ws-1" })).toBe("IGQV-secret-token");
  });
  it("uses a fresh IV every time", () => {
    const a = encryptToken("same", { resolve, version: 1, aad: "ws" });
    const b = encryptToken("same", { resolve, version: 1, aad: "ws" });
    expect(a).not.toBe(b);
  });
  it("binds ciphertext to its workspace (AAD)", () => {
    const c = encryptToken("token", { resolve, version: 1, aad: "ws-A" });
    expect(() => decryptToken(c, { resolve, aad: "ws-B" })).toThrow();
  });
  it("detects tampering", () => {
    const c = encryptToken("token", { resolve, version: 1, aad: "ws" });
    const parts = c.split(":");
    const data = Buffer.from(parts[3]!, "base64url");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64url");
    expect(() => decryptToken(parts.join(":"), { resolve, aad: "ws" })).toThrow();
  });
  it("supports key rotation via embedded version", () => {
    const old = encryptToken("token", { resolve, version: 1, aad: "ws" });
    const fresh = encryptToken("token", { resolve, version: 2, aad: "ws" });
    expect(keyVersionOf(old)).toBe(1);
    expect(keyVersionOf(fresh)).toBe(2);
    expect(decryptToken(old, { resolve, aad: "ws" })).toBe("token");
    expect(decryptToken(fresh, { resolve, aad: "ws" })).toBe("token");
  });
  it("fails closed on missing or wrong-size keys", () => {
    expect(() => encryptToken("t", { resolve: () => undefined, version: 1, aad: "ws" })).toThrow(/not configured/);
    expect(() => encryptToken("t", { resolve: () => Buffer.alloc(16).toString("base64"), version: 1, aad: "ws" })).toThrow(/32 bytes/);
    expect(() => decryptToken("garbage", { resolve, aad: "ws" })).toThrow(/Malformed/);
  });
});
