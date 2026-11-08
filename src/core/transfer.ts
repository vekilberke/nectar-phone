// File and text transfer on the phone (design section 7), byte-compatible with
// src-tauri/src/phone_link/transfer.rs: 4 MiB chunks, one encrypted Storage object each,
// signed upload URLs from `link-upload`, and the per-direction mailbox for an offline PC.
// No DOM here: the browser plugs in a Web Worker and OPFS, tests and the simulated phone
// use the in-memory versions at the bottom.

import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, equalBytes, fromUtf8, hex, randomBytes, unb64u, unb64uLen, unhex, utf8 } from "./bytes";
import * as c from "./crypto";
import { cleanText } from "./protocol";

export const CHUNK = 4 * 1024 * 1024;
export const MAX_CHUNKS = 64;
/** Phone to PC: the PC's own limit (100 MB by default, at most 200) decides; this is the hard cap. */
export const MAX_SEND_BYTES = 200 * 1024 * 1024;
/** Phone to PC while the PC has not told its limit yet (its default, D-024). */
export const DEFAULT_SEND_BYTES = 100 * 1024 * 1024;
/** PC to phone: at most 100 MB (design 11), kept on the phone's disk in OPFS. */
export const MAX_RECEIVE_BYTES = 100 * 1024 * 1024;
export const MAILBOX_MAX_AGE = 24 * 3600;
export const MAILBOX_MAX_BYTES = 128 * 1024;
const MAILBOX_FUTURE = 300;
const MAX_NAME = 120;

export type Dir = "p2c" | "c2p";

export interface Offer {
  t: "offer";
  fid: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  chunks: number;
  key: string;
}

export interface Plan {
  fid: Uint8Array;
  fidHex: string;
  key: Uint8Array;
  name: string;
  size: number;
  mime: string;
  sha256: Uint8Array;
  chunks: number;
}

export const isFid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);

export function chunkCount(size: number): number | null {
  if (!Number.isSafeInteger(size) || size < 0) return null;
  const n = Math.max(1, Math.ceil(size / CHUNK));
  return n <= MAX_CHUNKS ? n : null;
}

function cleanMime(mime: string): string {
  const m = Array.from(mime)
    .filter((ch) => ch > " " && ch <= "~")
    .join("")
    .slice(0, 100);
  return m.includes("/") ? m : "application/octet-stream";
}

/** A name safe to show and to offer (the PC sanitizes again for Windows). */
export function sanitizeName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? "";
  let name = cleanText(last.replace(/[<>:"|?*]|\p{Cf}/gu, ""), 255).replace(/^ +|[ .]+$/g, "");
  if (!name) name = "file";
  const chars = Array.from(name);
  if (chars.length > MAX_NAME) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = chars.slice(0, MAX_NAME - Array.from(ext).length).join("").replace(/[ .]+$/, "") + ext;
  }
  return name;
}

export function newPlan(name: string, size: number, mime: string, sha: Uint8Array): Plan | null {
  const chunks = chunkCount(size);
  if (chunks === null) return null;
  const fid = randomBytes(16);
  return { fid, fidHex: hex(fid), key: randomBytes(32), name: sanitizeName(name), size, mime: cleanMime(mime || "application/octet-stream"), sha256: sha, chunks };
}

export const offerOf = (p: Plan): Offer => ({ t: "offer", fid: p.fidHex, name: p.name, size: p.size, mime: p.mime, sha256: hex(p.sha256), chunks: p.chunks, key: b64u(p.key) });

const OFFER_KEYS = new Set(["t", "fid", "name", "size", "mime", "sha256", "chunks", "key"]);

/** Decodes and checks an offer from the PC; null is `invalid`. */
export function planOf(v: unknown): Plan | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !OFFER_KEYS.has(k)) || o.t !== "offer" || !isFid(o.fid)) return null;
  if (typeof o.name !== "string" || !o.name || typeof o.mime !== "string" || o.mime.length > 100 || typeof o.size !== "number" || typeof o.chunks !== "number") return null;
  if (chunkCount(o.size) !== o.chunks || typeof o.sha256 !== "string" || o.sha256.length !== 64) return null;
  const sha = unhex(o.sha256);
  const key = unb64uLen(o.key, 32);
  const fid = unhex(o.fid);
  if (!sha || !key || !fid) return null;
  return { fid, fidHex: o.fid, key, name: sanitizeName(o.name), size: o.size, mime: cleanMime(o.mime), sha256: sha, chunks: o.chunks };
}

export const blobPath = (topic: string, dir: Dir, fid: string, i: number) => `${topic}/blob/${dir}/${fid}/${i}`;
export const mboxPath = (topic: string, dir: Dir, fid: string) => `${topic}/mbox/${dir}/${fid}`;
export const mboxPrefix = (topic: string, dir: Dir) => `${topic}/mbox/${dir}`;

const dirByte = (dir: Dir) => (dir === "p2c" ? c.DIR_P2C : c.DIR_C2P);

export function chunkLen(p: Plan, i: number): number {
  return i + 1 === p.chunks ? p.size - i * CHUNK : CHUNK;
}

export function sealChunk(p: Plan, dir: Dir, i: number, data: Uint8Array): Uint8Array {
  return c.seal(p.key, c.chunkAad(dirByte(dir), p.fid, i, i + 1 === p.chunks), data);
}

/** Decrypts chunk `i` and checks its length against the offer. */
export function openChunk(p: Plan, dir: Dir, i: number, blob: Uint8Array): Uint8Array | null {
  const plain = c.open(p.key, c.chunkAad(dirByte(dir), p.fid, i, i + 1 === p.chunks), blob);
  return plain && plain.length === chunkLen(p, i) ? plain : null;
}

// Mailbox (design 7.4).

export function sealMailbox(kDev: Uint8Array, ep: number, topic: string, dir: Dir, fid: Uint8Array, created: number, inner: object): Uint8Array {
  const k = c.mailboxKey(kDev, dir);
  const ct = c.seal(k, c.mailboxAad(topic, dir, fid, created, ep), utf8(JSON.stringify(inner)));
  return utf8(JSON.stringify({ ep, created, c: b64u(ct) }));
}

export function openMailbox(keyFor: (ep: number) => Uint8Array | null, topic: string, dir: Dir, fid: Uint8Array, bytes: Uint8Array, nowSecs: number): Record<string, unknown> | null {
  if (bytes.length > MAILBOX_MAX_BYTES) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(fromUtf8(bytes) ?? "");
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Object.keys(o).some((k) => k !== "ep" && k !== "created" && k !== "c")) return null;
  const { ep, created } = o;
  if (typeof ep !== "number" || !Number.isSafeInteger(ep) || ep < 0 || typeof created !== "number" || !Number.isSafeInteger(created)) return null;
  if (nowSecs - created > MAILBOX_MAX_AGE || created - nowSecs > MAILBOX_FUTURE) return null;
  const kDev = keyFor(ep);
  const ct = unb64u(o.c);
  if (!kDev || !ct) return null;
  const plain = c.open(c.mailboxKey(kDev, dir), c.mailboxAad(topic, dir, fid, created, ep), ct);
  const text = plain && fromUtf8(plain);
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Storage.

export type XferError = "denied" | "tooBig" | "disk" | "invalid" | "busy" | "network" | "corrupt" | "io" | "expired" | "timeout" | "storage" | "offline" | "unsupported" | "folder";

export class BlobError extends Error {
  constructor(readonly code: XferError) {
    super(code);
  }
}

/** The relay's bucket: `link-upload` URLs, signed PUTs, reads, deletes, releases, listings. */
export interface Blobs {
  authorize(topic: string, dir: Dir, fid: string, count: number, kind: "blob" | "mailbox"): Promise<string[]>;
  put(url: string, body: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  delete(paths: string[]): Promise<void>;
  release(topic: string, dir: Dir, fid: string, kind: "blob" | "mailbox"): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export async function retry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof BlobError) || e.code !== "network" || attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/** Removes a received transfer's objects and frees its grants (receiver side, design 7.1). */
export async function discard(b: Blobs, topic: string, dir: Dir, fid: string, chunks: number, mailbox: boolean) {
  const paths = Array.from({ length: chunks }, (_, i) => blobPath(topic, dir, fid, i));
  if (mailbox) paths.push(mboxPath(topic, dir, fid));
  if (paths.length) await retry(() => b.delete(paths));
  if (chunks) await retry(() => b.release(topic, dir, fid, "blob")).catch(() => {});
  if (mailbox) await retry(() => b.release(topic, dir, fid, "mailbox")).catch(() => {});
}

// Where the work happens: the browser uses a Web Worker with OPFS, everything else memory.

/** Decrypts, verifies and stores an incoming file chunk by chunk. */
export interface Sink {
  write(i: number, blob: Uint8Array): Promise<void>;
  /** SHA-256 of everything written. */
  finish(): Promise<Uint8Array>;
  abort(): Promise<void>;
}

export interface FileCrypto {
  hash(file: Blob, onProgress?: (done: number) => void): Promise<Uint8Array>;
  /** Reads chunk `i` of the file and encrypts it phone-to-PC. */
  seal(file: Blob, plan: Plan, i: number): Promise<Uint8Array>;
  sink(plan: Plan): Promise<Sink>;
}

/** Received files kept until the user saves or dismisses them (OPFS in the browser). */
export interface FileShelf {
  get(fid: string): Promise<Blob | null>;
  remove(fid: string): Promise<void>;
  /** fids present, for clean-up of files the app no longer lists. */
  list(): Promise<string[]>;
}

/** Same steps as the worker, on the calling thread; files land in `files`. */
export class InlineCrypto implements FileCrypto, FileShelf {
  files = new Map<string, Uint8Array>();

  async hash(file: Blob, onProgress?: (done: number) => void) {
    const h = sha256.create();
    for (let at = 0; at < file.size || at === 0; at += CHUNK) {
      h.update(new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()));
      onProgress?.(Math.min(file.size, at + CHUNK));
      if (file.size === 0) break;
    }
    return h.digest();
  }

  async seal(file: Blob, plan: Plan, i: number) {
    const data = new Uint8Array(await file.slice(i * CHUNK, i * CHUNK + chunkLen(plan, i)).arrayBuffer());
    if (data.length !== chunkLen(plan, i)) throw new BlobError("io");
    return sealChunk(plan, "p2c", i, data);
  }

  async sink(plan: Plan): Promise<Sink> {
    const h = sha256.create();
    const parts: Uint8Array[] = [];
    let next = 0;
    return {
      write: async (i, blob) => {
        const plain = i === next ? openChunk(plan, "c2p", i, blob) : null;
        if (!plain) throw new BlobError("corrupt");
        h.update(plain);
        parts.push(plain);
        next++;
      },
      finish: async () => {
        if (next !== plan.chunks) throw new BlobError("corrupt");
        const out = new Uint8Array(plan.size);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.length;
        }
        this.files.set(plan.fidHex, out);
        return h.digest();
      },
      abort: async () => {
        parts.length = 0;
        this.files.delete(plan.fidHex);
      },
    };
  }

  async get(fid: string) {
    const f = this.files.get(fid);
    return f ? new Blob([f as BlobPart]) : null;
  }

  async remove(fid: string) {
    this.files.delete(fid);
  }

  async list() {
    return [...this.files.keys()];
  }
}

/** Downloads, decrypts and verifies a PC-to-phone transfer into the sink. */
export async function receiveFile(b: Blobs, crypto: FileCrypto, topic: string, plan: Plan, onProgress: (done: number) => void): Promise<void> {
  const sink = await crypto.sink(plan);
  try {
    let done = 0;
    for (let i = 0; i < plan.chunks; i++) {
      const blob = await retry(() => b.get(blobPath(topic, "c2p", plan.fidHex, i)));
      await sink.write(i, blob);
      done += chunkLen(plan, i);
      onProgress(done);
    }
    const sha = await sink.finish();
    if (!equalBytes(sha, plan.sha256)) throw new BlobError("corrupt");
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
}

/** Encrypts and uploads a phone-to-PC file. */
export async function uploadFile(b: Blobs, crypto: FileCrypto, topic: string, file: Blob, plan: Plan, onProgress: (done: number) => void): Promise<void> {
  if (file.size !== plan.size) throw new BlobError("corrupt");
  const urls = await retry(() => b.authorize(topic, "p2c", plan.fidHex, plan.chunks, "blob"));
  if (urls.length !== plan.chunks) throw new BlobError("network");
  let done = 0;
  for (let i = 0; i < plan.chunks; i++) {
    const blob = await crypto.seal(file, plan, i);
    await retry(() => b.put(urls[i], blob));
    done += chunkLen(plan, i);
    onProgress(done);
  }
}

export async function uploadMailbox(b: Blobs, topic: string, fid: string, object: Uint8Array): Promise<void> {
  const [url] = await retry(() => b.authorize(topic, "p2c", fid, 1, "mailbox"));
  if (!url) throw new BlobError("network");
  await retry(() => b.put(url, object));
}
