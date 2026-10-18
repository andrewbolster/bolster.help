// How a saved API key is sealed: AES-GCM under USER_CONFIG_KEY, bound to its
// owner. These are the properties that make a database leak not a key leak.

import { describe, expect, it } from "vitest";
import { configKey, decryptKey, encryptKey } from "../../worker/src/userconfig.js";

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const randomSecret = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const SECRET_KEY = "sk-live-0123456789abcdef";

describe("configKey fails closed", () => {
  it("is a usable key for 32 base64 bytes", async () => {
    expect(await configKey({ USER_CONFIG_KEY: randomSecret() })).not.toBeNull();
  });

  it("is null when the secret is missing", async () => {
    expect(await configKey({})).toBeNull();
    expect(await configKey({ USER_CONFIG_KEY: "" })).toBeNull();
  });

  it("is null when it is the wrong length or not base64", async () => {
    expect(await configKey({ USER_CONFIG_KEY: b64(new Uint8Array(16)) })).toBeNull();
    expect(await configKey({ USER_CONFIG_KEY: b64(new Uint8Array(64)) })).toBeNull();
    expect(await configKey({ USER_CONFIG_KEY: "not base64 !!!" })).toBeNull();
  });
});

describe("encryptKey / decryptKey", () => {
  it("round-trips", async () => {
    const key = await configKey({ USER_CONFIG_KEY: randomSecret() });
    const sealed = await encryptKey(key, 1, SECRET_KEY);
    expect(await decryptKey(key, 1, sealed)).toBe(SECRET_KEY);
  });

  it("stores no plaintext", async () => {
    const key = await configKey({ USER_CONFIG_KEY: randomSecret() });
    const sealed = await encryptKey(key, 1, SECRET_KEY);
    expect(JSON.stringify(sealed)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(sealed)).not.toContain("0123456789");
  });

  it("uses a fresh IV, so equal keys do not produce equal ciphertext", async () => {
    const key = await configKey({ USER_CONFIG_KEY: randomSecret() });
    const a = await encryptKey(key, 1, SECRET_KEY);
    const b = await encryptKey(key, 1, SECRET_KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("will not decrypt for a different user, even with the right key", async () => {
    const key = await configKey({ USER_CONFIG_KEY: randomSecret() });
    const sealed = await encryptKey(key, 1, SECRET_KEY);
    await expect(decryptKey(key, 2, sealed)).rejects.toThrow();
  });

  it("will not decrypt tampered ciphertext or a swapped IV", async () => {
    const key = await configKey({ USER_CONFIG_KEY: randomSecret() });
    const sealed = await encryptKey(key, 1, SECRET_KEY);
    const bytes = Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    await expect(decryptKey(key, 1, { ...sealed, ciphertext: b64(bytes) })).rejects.toThrow();
    const other = await encryptKey(key, 1, SECRET_KEY);
    await expect(decryptKey(key, 1, { ciphertext: sealed.ciphertext, iv: other.iv })).rejects.toThrow();
  });

  it("will not decrypt under a different secret", async () => {
    const key = await configKey({ USER_CONFIG_KEY: randomSecret() });
    const other = await configKey({ USER_CONFIG_KEY: randomSecret() });
    const sealed = await encryptKey(key, 1, SECRET_KEY);
    await expect(decryptKey(other, 1, sealed)).rejects.toThrow();
  });
});
