// Test doubles: an in-memory relay bus, REST and store, and a minimal PC that speaks the
// protocol with the same crypto (the real PC is exercised by the Rust interop test).

import { b64u, fromUtf8, randomBytes, unb64u, unb64uLen, utf8 } from "../src/core/bytes";
import * as c from "../src/core/crypto";
import type { ReceivedFile, Store } from "../src/core/link";
import type { DeviceRecord } from "../src/core/protocol";
import { type AuthSession, type Channel, JoinError, RelayError, type RelayConfig } from "../src/core/relay";
import { BlobError, type Blobs, blobPath, type Dir, mboxPath } from "../src/core/transfer";

export const CFG: RelayConfig = { ref: "qziazuduzrdqnnwdlxqb", url: "https://qziazuduzrdqnnwdlxqb.supabase.co", anonKey: "k", pwaUrl: "https://x/" };

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await tick(5);
  }
}

export class MemoryStore implements Store {
  device: DeviceRecord | null = null;
  auth: AuthSession | null = null;
  async load() {
    return { device: this.device, auth: this.auth };
  }
  async saveDevice(d: DeviceRecord | null) {
    this.device = d ? structuredClone(d) : null;
  }
  async saveAuth(a: AuthSession | null) {
    this.auth = a;
  }
  files: ReceivedFile[] = [];
  processed: Record<string, number> = {};
  async loadFiles() {
    return { files: structuredClone(this.files), processed: { ...this.processed } };
  }
  async saveFiles(f: ReceivedFile[]) {
    this.files = structuredClone(f);
  }
  async saveProcessed(p: Record<string, number>) {
    this.processed = { ...p };
  }
}

let uidN = 0;
const uid = () => `00000000-0000-4000-8000-${String(++uidN).padStart(12, "0")}`;

export class FakeRest {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  rejoinError: string | null = null;
  signups = 0;
  async signupAnonymous(now: number): Promise<AuthSession> {
    this.signups++;
    return { accessToken: "tok-" + this.signups, refreshToken: "r", expiresAt: now + 3600, userId: uid() };
  }
  async refresh(_r: string, now: number): Promise<AuthSession> {
    return { accessToken: "tok-r", refreshToken: "r2", expiresAt: now + 3600, userId: uid() };
  }
  async rpc(_token: string, name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (this.rejoinError) throw new RelayError("status", 400, this.rejoinError);
    return null;
  }
}

/** One relay shared by the phone's channels and the fake PC. */
export class Bus {
  sent: { topic: string; event: string; payload: any }[] = [];
  unauthorized = new Set<string>();
  pc: FakePc | null = null;
  channels = new Set<FakeChannel>();
  deliverToPhone(topic: string, event: string, payload: unknown) {
    for (const ch of this.channels) if (ch.joined.has(topic)) ch.onBroadcast(topic, event, payload);
  }
}

export class FakeChannel implements Channel {
  onBroadcast: Channel["onBroadcast"] = () => {};
  onClose: Channel["onClose"] = () => {};
  joined = new Set<string>();
  closed = false;
  constructor(private bus: Bus) {
    bus.channels.add(this);
  }
  async join(topic: string) {
    if (this.closed) throw new JoinError("closed");
    if (this.bus.unauthorized.has(topic)) {
      this.bus.unauthorized.delete(topic);
      throw new JoinError("unauthorized");
    }
    this.joined.add(topic);
  }
  leave(topic: string) {
    this.joined.delete(topic);
  }
  async send(topic: string, event: string, payload: unknown) {
    if (!this.joined.has(topic)) throw new JoinError("closed");
    this.bus.sent.push({ topic, event, payload });
    queueMicrotask(() => this.bus.pc?.onPhone(topic, event, payload));
  }
  setToken() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.bus.channels.delete(this);
    this.onClose();
  }
}

/** Just enough of the PC: answers hello and hs1, seals messages, records what the phone sent. */
export class FakePc {
  ps = randomBytes(32);
  eph = c.keyPair();
  kDev: Uint8Array | null = null;
  ep = 0;
  topic = "";
  code = "";
  silent = false;
  sid: Uint8Array | null = null;
  keys: c.SessionKeys | null = null;
  sendN = 0;
  recvN = 0;
  inbox: any[] = [];
  hs1s: any[] = [];
  autoRes = true;
  onMsg: ((msg: any) => void) | null = null;

  constructor(private bus: Bus) {
    bus.pc = this;
  }

  qrHash(expiresAt: number) {
    const json = JSON.stringify({ r: CFG.ref, s: b64u(this.ps), p: b64u(this.eph.public), n: "TEST-PC", x: expiresAt });
    return "#v1." + b64u(utf8(json));
  }

  onPhone(topic: string, event: string, payload: any) {
    if (event === "hello" && topic === c.pairTopic(this.ps)) {
      const phPub = unb64uLen(payload.e, 32)!;
      const plain = c.open(c.helloKey(this.ps), c.helloAad(phPub), unb64u(payload.c)!);
      if (!plain || this.kDev) return;
      const shared = c.agree(this.eph, phPub)!;
      this.kDev = c.deviceKey(shared, this.ps, this.eph.public, phPub);
      this.code = c.sas(this.kDev);
      this.topic = c.deviceTopic(this.kDev);
      return;
    }
    if (topic !== this.topic || this.silent) return;
    if (event === "hs1") {
      this.hs1s.push(payload);
      const sid = unb64uLen(payload.sid, 16)!;
      const ePh = unb64uLen(payload.e, 32)!;
      if (payload.ep !== this.ep || !c.hmacVerify(this.kDev!, unb64u(payload.m)!, utf8("hs1"), sid, ePh, u64(payload.ts), u32(payload.ep))) return;
      const ePc = c.keyPair();
      this.sid = sid;
      this.keys = c.sessionKeys(c.agree(ePc, ePh)!, this.kDev!, sid, ePh, ePc.public);
      this.sendN = this.recvN = 0;
      this.bus.deliverToPhone(topic, "hs2", { sid: payload.sid, e: b64u(ePc.public), m: b64u(c.hs2Mac(this.kDev!, sid, ePh, ePc.public)) });
    } else if (event === "m" && this.keys && payload.sid === b64u(this.sid!)) {
      const plain = c.open(this.keys.p2c, c.msgAad(topic, this.sid!, c.DIR_P2C, payload.n), unb64u(payload.c)!);
      if (!plain || payload.n <= this.recvN) return;
      this.recvN = payload.n;
      const msg = JSON.parse(fromUtf8(plain)!);
      this.inbox.push(msg);
      this.onMsg?.(msg);
      if (msg.t === "rekeyed" && msg.ep === this.ep + 1 && this.proposed) {
        this.kDev = this.proposed;
        this.ep = msg.ep;
        this.proposed = null;
      }
      if (this.autoRes && (msg.t === "cmd" || (msg.t === "text" && msg.id))) this.seal({ t: "res", id: msg.id, ok: true, d: null });
    }
  }

  proposed: Uint8Array | null = null;

  welcome(perms: Record<string, unknown> = { media: true, status: true, volume: true }) {
    const inner = JSON.stringify({ id: b64u(randomBytes(16)), pc: "TEST-PC", perms });
    this.bus.deliverToPhone(c.pairTopic(this.ps), "welcome", { c: b64u(c.seal(c.welcomeKey(this.kDev!), utf8("welcome"), utf8(inner))) });
  }

  /** Seals a PC-to-phone message on the current session (or a given old one). */
  seal(inner: object, session?: { sid: Uint8Array; keys: c.SessionKeys; n: number }) {
    const sid = session?.sid ?? this.sid!;
    const keys = session?.keys ?? this.keys!;
    const n = session ? session.n : ++this.sendN;
    const ct = c.seal(keys.c2p, c.msgAad(this.topic, sid, c.DIR_C2P, n), utf8(JSON.stringify(inner)));
    this.bus.deliverToPhone(this.topic, "m", { sid: b64u(sid), n, c: b64u(ct) });
  }

  proposeRekey() {
    this.proposed = c.rekey(this.kDev!, this.keys!.rk, this.ep + 1);
    this.seal({ t: "rekey", ep: this.ep + 1 });
  }
}

const u64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

/** The relay bucket in memory; upload URLs are `mem://<path>`. */
export class MemBlobs implements Blobs {
  objects = new Map<string, Uint8Array>();
  released: string[] = [];
  async authorize(topic: string, dir: Dir, fid: string, count: number, kind: "blob" | "mailbox") {
    return kind === "mailbox" ? [`mem://${mboxPath(topic, dir, fid)}`] : Array.from({ length: count }, (_, i) => `mem://${blobPath(topic, dir, fid, i)}`);
  }
  async put(url: string, body: Uint8Array) {
    this.objects.set(url.slice(6), body.slice());
  }
  async get(path: string) {
    const o = this.objects.get(path);
    if (!o) throw new BlobError("invalid");
    return o.slice();
  }
  async delete(paths: string[]) {
    for (const p of paths) this.objects.delete(p);
  }
  async release(_topic: string, dir: Dir, fid: string, kind: string) {
    this.released.push(`${dir}/${fid}/${kind}`);
  }
  async list(prefix: string) {
    const p = prefix.endsWith("/") ? prefix : prefix + "/";
    return [...this.objects.keys()].filter((k) => k.startsWith(p) && !k.slice(p.length).includes("/")).map((k) => k.slice(p.length));
  }
}
