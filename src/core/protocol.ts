// Phone side of the phone link protocol (design sections 5 and 6, appendix B), without any
// network: QR parsing, hello / welcome, the hs1 / hs2 handshake, envelopes and the ratchet.

import { b64u, fromUtf8, randomBytes, unb64u, unb64uLen, utf8 } from "./bytes";
import * as c from "./crypto";
import type { Perms } from "./messages";

export const OFFER_MAX_SECS = 600;
/** Same cap as the PC: 64 KiB of plaintext plus nonce and tag. */
export const MAX_CIPHERTEXT = 64 * 1024 + c.NONCE_LEN + c.TAG_LEN;

export interface Qr {
  ref: string;
  ps: Uint8Array;
  pcPub: Uint8Array;
  pcName: string;
  expiresAt: number;
}

export type QrError = "format" | "relay" | "expired";

export function cleanText(text: unknown, limit: number): string {
  if (typeof text !== "string") return "";
  return Array.from(text.replace(/\p{Cc}/gu, "")).slice(0, limit).join("").trim();
}

/** Reads `#v1.<b64u(json)>`. Rejects a QR for another relay before any network call. */
export function parseQr(hash: string, relayRef: string, nowSecs: number): Qr | QrError {
  const m = /^#?v1\.([A-Za-z0-9_-]+)$/.exec(hash);
  const raw = m && unb64u(m[1]);
  const text = raw && fromUtf8(raw);
  let v: Record<string, unknown>;
  try {
    v = text ? JSON.parse(text) : null;
  } catch {
    return "format";
  }
  if (!v || typeof v !== "object") return "format";
  const ps = unb64uLen(v.s, 32);
  const pcPub = unb64uLen(v.p, 32);
  if (!ps || !pcPub || typeof v.x !== "number" || !Number.isSafeInteger(v.x) || typeof v.r !== "string") return "format";
  if (v.r !== relayRef) return "relay";
  if (v.x <= nowSecs || v.x > nowSecs + OFFER_MAX_SECS) return "expired";
  return { ref: v.r, ps, pcPub, pcName: cleanText(v.n, 40) || "PC", expiresAt: v.x };
}

export interface Welcome {
  id: string;
  pc: string;
  perms: Perms;
}

/** One pairing attempt: the ephemeral key, the hello, the code and the welcome. */
export class Pairing {
  readonly topic: string;
  readonly code: string;
  readonly deviceTopic: string;
  readonly kDev0: Uint8Array;
  readonly kRejoin: Uint8Array;
  private readonly eph = c.keyPair();
  private readonly helloPayload: { e: string; c: string };

  constructor(readonly qr: Qr, uid: string, name: string, ua: string) {
    const shared = c.agree(this.eph, qr.pcPub);
    if (!shared) throw new Error("bad pc key");
    this.topic = c.pairTopic(qr.ps);
    this.kDev0 = c.deviceKey(shared, qr.ps, qr.pcPub, this.eph.public);
    this.code = c.sas(this.kDev0);
    this.deviceTopic = c.deviceTopic(this.kDev0);
    this.kRejoin = c.rejoinKey(this.kDev0);
    const inner = JSON.stringify({ name: cleanText(name, 40), uid, ua: cleanText(ua, 80) });
    const sealed = c.seal(c.helloKey(qr.ps), c.helloAad(this.eph.public), utf8(inner));
    this.helloPayload = { e: b64u(this.eph.public), c: b64u(sealed) };
  }

  /** The same bytes every time, so a retry is a duplicate the PC ignores. */
  hello() {
    return this.helloPayload;
  }

  openWelcome(payload: unknown): Welcome | null {
    const sealed = unb64u((payload as { c?: unknown } | null)?.c);
    const plain = sealed && c.open(c.welcomeKey(this.kDev0), utf8("welcome"), sealed);
    const text = plain && fromUtf8(plain);
    if (!text) return null;
    try {
      const v = JSON.parse(text);
      if (!unb64uLen(v.id, 16) || typeof v.pc !== "string" || !v.perms || typeof v.perms !== "object") return null;
      return { id: v.id, pc: cleanText(v.pc, 40) || this.qr.pcName, perms: v.perms };
    } catch {
      return null;
    }
  }
}

/** What the phone stores per paired PC (IndexedDB; keys as b64u). */
export interface DeviceRecord {
  v: 1;
  id: string;
  pcName: string;
  topic: string;
  kDev: string;
  ep: number;
  kRejoin: string;
  /** The key before the last ratchet and its epoch, kept only to open mailbox items the PC sealed before it confirmed. */
  kPrev?: string;
  epPrev?: number;
  perms: Perms;
  pairedAt: number;
}

export function deviceRecord(p: Pairing, w: Welcome, now: number): DeviceRecord {
  return { v: 1, id: w.id, pcName: w.pc, topic: p.deviceTopic, kDev: b64u(p.kDev0), ep: 0, kRejoin: b64u(p.kRejoin), perms: w.perms, pairedAt: now };
}

export interface Envelope {
  sid: string;
  n: number;
  c: string;
}

/**
 * One session, started by `hs1`. The PWA keeps exactly one (appendix B, ratchet rule):
 * starting a new one drops the old keys, and only the current session may apply a rekey.
 */
export class Session {
  readonly sid = randomBytes(16);
  readonly sidText = b64u(this.sid);
  readonly ep: number;
  private readonly kDev: Uint8Array;
  private e: c.KeyPair | null = c.keyPair();
  private keys: c.SessionKeys | null = null;
  private sendN = 0;
  private recvN = 0;
  private rekeyed = false;

  constructor(readonly topic: string, kDev: Uint8Array, ep: number) {
    this.kDev = kDev;
    this.ep = ep;
  }

  get ready() {
    return this.keys !== null;
  }

  hs1(nowSecs: number) {
    const e = this.e!;
    return { sid: this.sidText, ep: this.ep, e: b64u(e.public), ts: nowSecs, m: b64u(c.hs1Mac(this.kDev, this.sid, e.public, nowSecs, this.ep)) };
  }

  /** Verifies `hs2` for this sid and derives the session keys. */
  onHs2(p: unknown): boolean {
    if (!this.e || this.keys || !p || typeof p !== "object") return false;
    const o = p as Record<string, unknown>;
    if (o.sid !== this.sidText) return false;
    const ePc = unb64uLen(o.e, 32);
    const tag = unb64uLen(o.m, 32);
    if (!ePc || !tag || !c.hmacVerify(this.kDev, tag, utf8("hs2"), this.sid, this.e.public, ePc)) return false;
    const shared = c.agree(this.e, ePc);
    if (!shared) return false;
    this.keys = c.sessionKeys(shared, this.kDev, this.sid, this.e.public, ePc);
    this.e.secret.fill(0);
    shared.fill(0);
    this.e = null;
    return true;
  }

  seal(inner: object): Envelope {
    if (!this.keys) throw new Error("session not ready");
    this.sendN += 1;
    const ct = c.seal(this.keys.p2c, c.msgAad(this.topic, this.sid, c.DIR_P2C, this.sendN), utf8(JSON.stringify(inner)));
    return { sid: this.sidText, n: this.sendN, c: b64u(ct) };
  }

  /** Decrypts a PC message of this session; anything else (old sid, replay, tamper) is null. */
  open(p: unknown): Record<string, unknown> | null {
    if (!this.keys || !p || typeof p !== "object") return null;
    const o = p as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "sid" && k !== "n" && k !== "c")) return null;
    if (o.sid !== this.sidText || typeof o.n !== "number" || !Number.isSafeInteger(o.n) || o.n <= this.recvN) return null;
    if (typeof o.c !== "string" || o.c.length > Math.ceil((MAX_CIPHERTEXT * 4) / 3) + 4) return null;
    const ct = unb64u(o.c);
    const plain = ct && c.open(this.keys.c2p, c.msgAad(this.topic, this.sid, c.DIR_C2P, o.n), ct);
    const text = plain && fromUtf8(plain);
    if (!text) return null;
    this.recvN = o.n;
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * `rekey` decrypted on this session: the next device key, or null when the epoch is not
   * the next one or this session already ratcheted. The caller stores it, then sends `rekeyed`.
   */
  nextKey(ep: unknown): { kDev: Uint8Array; ep: number } | null {
    if (!this.keys || this.rekeyed || ep !== this.ep + 1) return null;
    this.rekeyed = true;
    return { kDev: c.rekey(this.kDev, this.keys.rk, ep), ep };
  }

  close() {
    this.e?.secret.fill(0);
    this.e = null;
    if (this.keys) {
      this.keys.p2c.fill(0);
      this.keys.c2p.fill(0);
      this.keys.rk.fill(0);
    }
    this.keys = null;
  }
}
