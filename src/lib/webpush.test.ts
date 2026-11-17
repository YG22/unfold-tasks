// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { encryptPayload, unb64u, vapidFromSeed, vapidHeader } from "./webpush";

const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, k, len * 8));
}

describe("webpush", () => {
  it("derives the same VAPID key from the same seed", async () => {
    const a = await vapidFromSeed("abc"), b = await vapidFromSeed("abc");
    expect(a.pub).toEqual(b.pub);
    expect(a.pub.length).toBe(65);
  });

  it("encrypted payload decrypts on the receiving side (round trip, Hebrew)", async () => {
    const uaPriv = p256.utils.randomSecretKey();
    const uaPub = p256.getPublicKey(uaPriv, false);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = enc.encode(JSON.stringify({ title: "התראת בדיקה" }));
    const out = await encryptPayload(uaPub, auth, msg);
    const salt = out.slice(0, 16), idlen = out[20]!, asPub = out.slice(21, 21 + idlen), ct = out.slice(21 + idlen);
    const shared = p256.getSharedSecret(uaPriv, asPub).slice(1);
    const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPub, ...asPub]);
    const ikm = await hkdf(auth, shared, info, 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
    expect(pt[pt.length - 1]).toBe(2);
    expect(new TextDecoder().decode(pt.slice(0, -1))).toBe('{"title":"התראת בדיקה"}');
  });

  it("VAPID JWT verifies with Web Crypto ES256", async () => {
    const { priv, pub } = await vapidFromSeed("seed");
    const h = await vapidHeader("https://fcm.googleapis.com/fcm/send/x", priv, pub, "mailto:a@b.c");
    const t = h.match(/t=([^,]+)/)![1]!;
    const [a, b, s] = t.split(".") as [string, string, string];
    const k = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, unb64u(s), enc.encode(`${a}.${b}`));
    expect(ok).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(unb64u(b))).aud).toBe("https://fcm.googleapis.com");
  });
});
