// Minimal Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) using only Web Crypto,
// fetch and pure-JS @noble/curves, so it runs on Cloudflare Workers.
import { p256 } from "@noble/curves/nist.js";

const enc = new TextEncoder();
export const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const cat = (...a: Uint8Array[]) => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of a) { o.set(x, i); i += x.length; }
  return o;
};
const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** Derive a valid P-256 VAPID key pair from a random secret string. */
export async function vapidFromSeed(seed: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(seed)));
  let d = 0n;
  for (const x of h) d = (d << 8n) | BigInt(x);
  d = (d % (N - 1n)) + 1n;
  const priv = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { priv[i] = Number(d & 0xffn); d >>= 8n; }
  return { priv, pub: p256.getPublicKey(priv, false) };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, k, len * 8);
  return new Uint8Array(bits);
}

/** Encrypt a payload for a subscription (aes128gcm). */
export async function encryptPayload(
  p256dh: Uint8Array, auth: Uint8Array, plaintext: Uint8Array,
  ephPriv: Uint8Array = p256.utils.randomSecretKey(), salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
) {
  const ephPub = p256.getPublicKey(ephPriv, false);
  const shared = p256.getSharedSecret(ephPriv, p256dh).slice(1);
  const ikm = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), p256dh, ephPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, cat(plaintext, new Uint8Array([2])) as BufferSource));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return cat(salt, rs, new Uint8Array([ephPub.length]), ephPub, ct);
}

export async function vapidHeader(endpoint: string, priv: Uint8Array, pub: Uint8Array, subject: string) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = p256.sign(enc.encode(`${head}.${body}`), priv); // SHA-256 prehash, 64-byte compact
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${b64u(pub)}`;
}

export type Sub = { endpoint: string; p256dh: string; auth: string };

export async function sendPush(sub: Sub, payload: unknown, keys: { priv: Uint8Array; pub: Uint8Array }, subject: string) {
  const body = await encryptPayload(unb64u(sub.p256dh), unb64u(sub.auth), enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, keys.priv, keys.pub, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: "high",
    },
    body: body as BodyInit,
  });
  return { status: res.status, text: res.ok ? "" : (await res.text()).slice(0, 300) };
}
