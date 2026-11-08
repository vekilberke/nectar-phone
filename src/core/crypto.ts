// Phone link crypto, byte-compatible with src-tauri/src/phone_link/crypto.rs
// (design sections 3, 5, 6, 7; pinned by phone/test-vectors.json).

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac as nobleHmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, hex, randomBytes, u32be, u64be, utf8 as s } from "./bytes";

export const NONCE_LEN = 24;
export const TAG_LEN = 16;
export const DIR_P2C = 1;
export const DIR_C2P = 2;

const EMPTY = new Uint8Array(0);

export function hkdfN(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  return hkdf(sha256, ikm, salt, info, len);
}

export function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  return nobleHmac(sha256, key, concat(...parts));
}

export function hmacVerify(key: Uint8Array, tag: Uint8Array, ...parts: Uint8Array[]): boolean {
  return equalBytes(hmac(key, ...parts), tag);
}

export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return concat(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext));
}

/** `nonce24 || ciphertext || tag` with a fresh random nonce. */
export function seal(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return sealWithNonce(key, randomBytes(NONCE_LEN), aad, plaintext);
}

export function open(key: Uint8Array, aad: Uint8Array, data: Uint8Array): Uint8Array | null {
  if (data.length < NONCE_LEN + TAG_LEN) return null;
  try {
    return xchacha20poly1305(key, data.subarray(0, NONCE_LEN), aad).decrypt(data.subarray(NONCE_LEN));
  } catch {
    return null;
  }
}

export interface KeyPair {
  secret: Uint8Array;
  public: Uint8Array;
}

export function keyPair(secret: Uint8Array = randomBytes(32)): KeyPair {
  return { secret, public: x25519.getPublicKey(secret) };
}

/** X25519. Rejects low-order peer keys (all-zero shared secret), like the PC. */
export function agree(own: KeyPair, peer: Uint8Array): Uint8Array | null {
  try {
    const shared = x25519.getSharedSecret(own.secret, peer);
    return shared.every((b) => b === 0) ? null : shared;
  } catch {
    return null;
  }
}

// Pairing (section 5).

export const pairTopic = (ps: Uint8Array) => "nlp-" + hex(hkdfN(ps, EMPTY, s("nectar-link v1 pair-topic"), 16));
export const helloKey = (ps: Uint8Array) => hkdfN(ps, EMPTY, s("nectar-link v1 hello"), 32);
export const helloAad = (phPub: Uint8Array) => concat(s("hello"), phPub);
export const deviceKey = (shared: Uint8Array, ps: Uint8Array, pcPub: Uint8Array, phPub: Uint8Array) =>
  hkdfN(shared, ps, concat(s("nectar-link v1 device"), pcPub, phPub), 32);

export function sas(kDev0: Uint8Array): string {
  const four = hkdfN(kDev0, EMPTY, s("nectar-link v1 sas"), 4);
  const n = new DataView(four.buffer, four.byteOffset, 4).getUint32(0, false);
  return String(n % 1_000_000).padStart(6, "0");
}

export const deviceTopic = (kDev0: Uint8Array) => "nl-" + hex(hkdfN(kDev0, EMPTY, s("nectar-link v1 topic"), 16));
export const rejoinKey = (kDev0: Uint8Array) => hkdfN(kDev0, EMPTY, s("nectar-link v1 rejoin"), 32);
export const welcomeKey = (kDev0: Uint8Array) => hkdfN(kDev0, EMPTY, s("nectar-link v1 welcome"), 32);

// Relay RPC MACs: ts is decimal text, as the SQL computes it (I-105).

export const ownerMac = (kOwner: Uint8Array, uid: string, ts: number) =>
  hmac(kOwner, s("nectar-link v1 owner"), s(uid), s(String(ts)));
export const rejoinMac = (kRejoin: Uint8Array, topic: string, uid: string, ts: number) =>
  hmac(kRejoin, s("nectar-link v1 rejoin"), s(topic), s(uid), s(String(ts)));

// Session handshake (section 6.1).

export const hs1Mac = (kDev: Uint8Array, sid: Uint8Array, ePh: Uint8Array, ts: number, ep: number) =>
  hmac(kDev, s("hs1"), sid, ePh, u64be(ts), u32be(ep));
export const hs2Mac = (kDev: Uint8Array, sid: Uint8Array, ePh: Uint8Array, ePc: Uint8Array) =>
  hmac(kDev, s("hs2"), sid, ePh, ePc);

export interface SessionKeys {
  p2c: Uint8Array;
  c2p: Uint8Array;
  rk: Uint8Array;
}

export function sessionKeys(shared: Uint8Array, kDev: Uint8Array, sid: Uint8Array, ePh: Uint8Array, ePc: Uint8Array): SessionKeys {
  const okm = hkdfN(shared, kDev, concat(s("nectar-link v1 session"), sid, ePh, ePc), 96);
  return { p2c: okm.slice(0, 32), c2p: okm.slice(32, 64), rk: okm.slice(64, 96) };
}

/** Device key ratchet (section 6.2). */
export const rekey = (kDev: Uint8Array, kRk: Uint8Array, nextEp: number) =>
  hkdfN(kDev, kRk, concat(s("nectar-link v1 rekey"), u32be(nextEp)), 32);

// Envelopes (sections 6.3, 7.1, 7.4).

export const msgAad = (topic: string, sid: Uint8Array, dir: number, n: number) =>
  concat(s("nectar-link v1 msg"), s(topic), sid, Uint8Array.of(dir), u64be(n));
export const chunkAad = (dir: number, fid: Uint8Array, index: number, last: boolean) =>
  concat(s("nectar-link v1 chunk"), Uint8Array.of(dir), fid, u32be(index), Uint8Array.of(last ? 1 : 0));
export const mailboxKey = (kDev: Uint8Array, dir: "p2c" | "c2p") => hkdfN(kDev, EMPTY, s(`nectar-link v1 mailbox ${dir}`), 32);
export const mailboxAad = (topic: string, dir: string, fid: Uint8Array, created: number, ep: number) =>
  concat(s("nectar-link v1 mbox"), s(topic), s(dir), fid, u64be(created), u32be(ep));

export { sha256 };
