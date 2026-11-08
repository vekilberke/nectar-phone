// The phone's link controller: relay auth and rejoin, pairing, the session handshake, the
// ratchet, commands with replies, keepalive and reconnects (design 5, 6, appendix B).
// The UI renders `snapshot()`; nothing here touches the DOM.

import { b64u, hex, randomBytes, unb64uLen, unhex, utf8 } from "./bytes";
import { rejoinMac } from "./crypto";
import { MAX_INNER, MAX_TEXT, type Op, parsePcMessage, type Perms, type ResError, type Status } from "./messages";
import { type DeviceRecord, deviceRecord, Pairing, type Qr, Session } from "./protocol";
import { type AuthSession, bytea, type Channel, JoinError, RelayError, type Rest } from "./relay";
import {
  BlobError,
  type Blobs,
  chunkCount,
  discard,
  type FileCrypto,
  type FileShelf,
  isFid,
  MAX_RECEIVE_BYTES,
  DEFAULT_SEND_BYTES,
  MAX_SEND_BYTES,
  mboxPath,
  mboxPrefix,
  newPlan,
  offerOf,
  openMailbox,
  type Plan,
  planOf,
  receiveFile,
  sealMailbox,
  uploadFile,
  uploadMailbox,
  type XferError,
} from "./transfer";

export interface Store {
  load(): Promise<{ device: DeviceRecord | null; auth: AuthSession | null }>;
  saveDevice(d: DeviceRecord | null): Promise<void>;
  saveAuth(a: AuthSession | null): Promise<void>;
  /** Received files (their bytes are in the FileShelf) and mailbox fids already handled. */
  loadFiles(): Promise<{ files: ReceivedFile[]; processed: Record<string, number> }>;
  saveFiles(files: ReceivedFile[]): Promise<void>;
  saveProcessed(p: Record<string, number>): Promise<void>;
}

export type TransferState = "preparing" | "offering" | "uploading" | "saving" | "saved" | "queued" | "incoming" | "downloading" | "ready" | "failed";

export interface TransferView {
  id: string;
  dir: "p2c" | "c2p";
  name: string;
  size: number;
  done: number;
  state: TransferState;
  e?: XferError;
  at: number;
}

export interface ReceivedFile {
  fid: string;
  name: string;
  size: number;
  mime: string;
  /** ms */
  at: number;
}

export type Conn = "idle" | "connecting" | "handshake" | "online" | "waiting" | "ended" | "offline" | "paused" | "revoked";
export type PairError = "expired" | "network" | "paused";

export interface PairingView {
  step: "joining" | "code" | "done" | "error";
  pcName: string;
  expiresAt: number;
  code?: string;
  error?: PairError;
}

export interface InboxItem {
  id: number;
  text: string;
  at: number;
  /** Copied on the PC (T-016); the inbox keeps only the newest such item. */
  clip?: true;
  /** Written to this phone's clipboard by itself. */
  copied?: boolean;
}

export interface Snapshot {
  device: { pcName: string; perms: Perms; pairedAt: number } | null;
  conn: Conn;
  pairing: PairingView | null;
  status: Status | null;
  inbox: InboxItem[];
  transfers: TransferView[];
  files: ReceivedFile[];
}

export type Result = { ok: true; d: unknown } | { ok: false; e: ResError };

export const TIMING = {
  /** No hs2 after this: the PC is offline or dropped the hs1 (rate limit), try again. */
  hs2Ms: 10_000,
  /** No res after this: the session is dead (appendix B). */
  resMs: 10_000,
  pingMs: 60_000,
  /** The PC ends a session after 150 s without a phone message; start over before that. */
  idleMs: 140_000,
  helloEveryMs: 4_000,
  retryMinMs: 1_000,
  retryMaxMs: 30_000,
  refreshBeforeSecs: 120,
  /** The PC answers an offer with accept or reject. */
  acceptMs: 30_000,
  /** The PC downloads and saves after `done`. */
  savedMs: 10 * 60_000,
};

/** Received files and finished transfers older than this are cleaned up. */
const FILE_KEEP_MS = 24 * 3600_000;
const PROCESSED_KEEP_SECS = 48 * 3600;
const MAX_INCOMING = 4;
/** A PC copy stamped further ahead of this phone's clock than this is not trusted to order later copies. */
const CLIP_SKEW_MS = 5 * 60_000;
const MAX_LISTED = 12;

type Answer = { t: "accept" } | { t: "saved" } | { t: "reject"; e: string };

export interface LinkOptions {
  store: Store;
  rest: Rest;
  channel: () => Channel;
  identity: () => { name: string; ua: string };
  now?: () => number;
  timing?: Partial<typeof TIMING>;
  onPaired?: () => void;
  /** Storage for transfers; gets the current access token on every call. */
  blobs?: (token: () => string) => Blobs;
  /** Hashing, encryption and the received-file shelf (Web Worker + OPFS in the browser). */
  files?: FileCrypto & FileShelf;
  /** Writes PC clipboard text to this phone's clipboard; false when the page may not (hidden, not focused, no permission). */
  clipboard?: { write(text: string): Promise<boolean> };
}

class Revoked extends Error {}

export class Link {
  private readonly t: typeof TIMING;
  private readonly now: () => number;
  private snap: Snapshot = { device: null, conn: "idle", pairing: null, status: null, inbox: [], transfers: [], files: [] };
  private listeners = new Set<() => void>();
  private device: DeviceRecord | null = null;
  private auth: AuthSession | null = null;
  private ch: Channel | null = null;
  private session: Session | null = null;
  private gen = 0;
  private wake: (() => void) | null = null;
  private pending = new Map<number, { resolve: (r: Result) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private inboxId = 0;
  private visible = true;
  private lastOut = 0;
  private hsTimer: ReturnType<typeof setTimeout> | null = null;
  private hsFailures = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pairing: { p: Pairing; done: boolean } | null = null;
  private inbound: Promise<void> = Promise.resolve();
  private waiters = new Map<string, { kinds: Answer["t"][]; resolve: (a: Answer | null) => void; timer: ReturnType<typeof setTimeout>; session: Session | null }>();
  private incoming = new Map<string, { plan: Plan; mailbox: boolean; started?: boolean }>();
  /** Transfer answers (`reject`, `saved`) that found no session: sent after the next hs2. */
  private unsent = new Map<string, object>();
  /** A mailbox item waited because `MAX_INCOMING` was reached; scan again when one ends. */
  private rescanWanted = false;
  private scanAgain = false;
  /** The PC's limit for files from the phone, from its status. */
  private pcMaxIn = DEFAULT_SEND_BYTES;
  private processed: Record<string, number> = {};
  private scanning = false;
  private tmpId = 0;
  /** The newest PC copy seen (PC clock in ms, text), the `at` below which a copy is older, and the inbox id about to be written. */
  private clipAt = -1;
  private clipText = "";
  private clipFloor = -1;
  private clipAuto: number | null = null;
  private clipWrites: Promise<void> = Promise.resolve();

  constructor(private readonly o: LinkOptions) {
    this.t = { ...TIMING, ...o.timing };
    this.now = o.now ?? (() => Date.now());
  }

  // UI surface.

  snapshot = (): Snapshot => this.snap;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  private setConn(conn: Conn) {
    if (this.snap.conn !== conn) this.set({ conn });
  }

  private showDevice() {
    const d = this.device;
    this.set({ device: d ? { pcName: d.pcName, perms: d.perms, pairedAt: d.pairedAt } : null });
  }

  /**
   * Loads the pairing from the store and connects. Called every time this tab gets the session
   * lock: another tab may have ratcheted the key or rotated the refresh token meanwhile, and a
   * hs1 under a superseded key makes the PC suspend the phone as a clone.
   */
  async start() {
    this.stop();
    const g = this.gen;
    const { device, auth } = await this.o.store.load();
    if (g !== this.gen) return;
    this.device = device;
    this.auth = auth;
    this.showDevice();
    await this.loadFiles();
    if (g !== this.gen) return;
    if (device) void this.run();
  }

  private async loadFiles() {
    const { files, processed } = await this.o.store.loadFiles().catch(() => ({ files: [] as ReceivedFile[], processed: {} }));
    const now = this.now();
    const keep = files.filter((f) => now - f.at < FILE_KEEP_MS);
    const nowS = Math.floor(now / 1000);
    this.processed = Object.fromEntries(Object.entries(processed).filter(([, t]) => nowS - t < PROCESSED_KEEP_SECS));
    const shelf = this.o.files;
    if (shelf) {
      const listed = new Set(keep.map((f) => f.fid));
      for (const fid of await shelf.list().catch(() => [] as string[])) if (!listed.has(fid)) await shelf.remove(fid).catch(() => {});
    }
    if (keep.length !== files.length) await this.o.store.saveFiles(keep).catch(() => {});
    this.set({ files: keep });
  }

  /** Stops every loop and socket; the stored pairing stays. */
  stop() {
    this.gen++;
    this.teardown();
    this.wake?.();
    this.setConn("idle");
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) return;
    const c = this.snap.conn;
    if (c === "online") {
      if (this.now() - this.lastOut > this.t.idleMs) this.startSession();
      else if (this.device?.perms.status) void this.command("status.get");
      else this.send({ t: "ping" });
    } else if (c === "ended" || (c === "waiting" && this.ch)) {
      this.startSession();
    } else {
      this.wake?.();
    }
  }

  /**
   * The page is going away (closed, reloaded or put in the back-forward cache): tells the PC,
   * so its later copies wait in the mailbox instead of going to a session nobody reads. Not on
   * every hide: transfers and a quick switch back keep the session.
   */
  leave() {
    if (!this.send({ t: "bye" })) return;
    this.endSession();
    if (this.hsTimer) clearTimeout(this.hsTimer);
    this.hsTimer = null;
    this.setConn("ended");
  }

  reconnect() {
    if (!this.device) return;
    if (this.snap.conn === "ended" && this.ch) {
      this.startSession();
      return;
    }
    this.stop();
    void this.run();
  }

  async command(op: Op, a?: Record<string, unknown>): Promise<Result> {
    const id = this.nextReq();
    return this.request(id, a === undefined ? { t: "cmd", id, op } : { t: "cmd", id, op, a });
  }

  /** Text to the PC; when it has no live session the text waits in its mailbox (24 h). */
  async sendText(text: string): Promise<Result> {
    if (!text) return { ok: false, e: "invalid" };
    if (utf8(text).length > MAX_TEXT) return { ok: false, e: "tooLong" };
    if (this.snap.conn !== "online") return this.queueText(text);
    const id = this.nextReq();
    return this.request(id, { t: "text", id, text });
  }

  private async queueText(text: string): Promise<Result> {
    const d = this.device;
    if (!d || !this.o.blobs) return { ok: false, e: "offline" };
    if (!d.perms.textIn) return { ok: false, e: "denied" };
    const fid = randomBytes(16);
    try {
      await this.withMembership(async (b) => uploadMailbox(b, d.topic, hex(fid), this.mailboxObject(d, fid, { t: "text", text })));
      return { ok: true, d: { queued: true } };
    } catch (e) {
      return { ok: false, e: xferCode(e) };
    }
  }

  private mailboxObject(d: DeviceRecord, fid: Uint8Array, inner: object): Uint8Array {
    const kDev = unb64uLen(d.kDev, 32);
    if (!kDev) throw new BlobError("invalid");
    return sealMailbox(kDev, d.ep, d.topic, "p2c", fid, Math.floor(this.now() / 1000), inner);
  }

  /** Runs relay storage calls; after a lost anonymous user, rejoins once and tries again. */
  private async withMembership<T>(f: (b: Blobs) => Promise<T>): Promise<T> {
    if (!this.o.blobs) throw new BlobError("unsupported");
    await this.ensureAuth();
    const b = this.o.blobs(() => this.auth?.accessToken ?? "");
    try {
      return await f(b);
    } catch (e) {
      if (!(e instanceof BlobError) || e.code !== "denied") throw e;
      await this.rejoin();
      return f(b);
    }
  }

  // Transfers (design section 7).

  private setTransfer(id: string, patch: Partial<TransferView> & { id?: string }) {
    const list = this.snap.transfers;
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) return;
    const next = [...list];
    next[i] = { ...list[i], ...patch };
    this.set({ transfers: next });
  }

  private addTransfer(t: TransferView) {
    this.set({ transfers: [t, ...this.snap.transfers.filter((x) => x.id !== t.id)].slice(0, MAX_LISTED) });
  }

  dismissTransfer(id: string) {
    this.set({ transfers: this.snap.transfers.filter((t) => t.id !== id) });
  }

  /** Waits for the PC's answer about a transfer; null on timeout or when the session that carried the offer ends. */
  private wait(fid: string, kinds: Answer["t"][], ms: number, session: Session | null): Promise<Answer | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(fid);
        resolve(null);
      }, ms);
      this.waiters.set(fid, { kinds, resolve, timer, session });
    });
  }

  private answer(fid: string, a: Answer) {
    const w = this.waiters.get(fid);
    if (!w || !w.kinds.includes(a.t)) return;
    clearTimeout(w.timer);
    this.waiters.delete(fid);
    w.resolve(a);
  }

  /**
   * Phone to PC (permission `filesIn` on the PC): hashes the file, then over a live session
   * offers it, uploads after `accept` and waits for `saved`; without a session the chunks
   * and an encrypted offer go to the PC's mailbox.
   */
  async sendFile(file: File): Promise<Result> {
    const d = this.device;
    const crypto = this.o.files;
    if (!d) return { ok: false, e: "offline" };
    if (!crypto || !this.o.blobs) return { ok: false, e: "unsupported" };
    if (!d.perms.filesIn) return { ok: false, e: "denied" };
    if (file.size > this.pcMaxIn || chunkCount(file.size) === null) return { ok: false, e: "tooBig" };
    let id = `tmp-${++this.tmpId}`;
    let offered: Plan | null = null;
    let doneSent = false;
    const fail = (e: XferError): Result => {
      this.setTransfer(id, { state: "failed", e });
      // After a live offer the PC holds a slot for it: say so, and remove what was uploaded.
      // Once `done` went out the PC is downloading and cleans up itself.
      const plan = offered;
      if (plan) {
        this.sendOrKeep(plan.fidHex, { t: "reject", fid: plan.fidHex, e });
        if (!doneSent) void this.withMembership((b) => discard(b, d.topic, "p2c", plan.fidHex, plan.chunks, false)).catch(() => {});
      }
      return { ok: false, e };
    };
    this.addTransfer({ id, dir: "p2c", name: file.name || "file", size: file.size, done: 0, state: "preparing", at: this.now() });
    try {
      const sha = await crypto.hash(file, (done) => this.setTransfer(id, { done }));
      const plan = newPlan(file.name, file.size, file.type, sha);
      if (!plan) return fail("tooBig");
      this.setTransfer(id, { id: plan.fidHex, name: plan.name, done: 0 });
      id = plan.fidHex;
      const progress = (done: number) => this.setTransfer(id, { done });
      if (this.snap.conn === "online" && this.session?.ready) {
        this.setTransfer(id, { state: "offering" });
        const s = this.session;
        const asked = this.wait(id, ["accept", "reject"], this.t.acceptMs, s);
        if (!this.send(offerOf(plan))) return fail("offline");
        offered = plan;
        const a = await asked;
        if (!a) return fail(this.session === s ? "timeout" : "offline");
        if (a.t === "reject") {
          offered = null;
          return fail(rejectCode(a.e));
        }
        this.setTransfer(id, { state: "uploading" });
        await this.withMembership((b) => uploadFile(b, crypto, d.topic, file, plan, progress));
        const saved = this.wait(id, ["saved", "reject"], this.t.savedMs, null);
        if (!this.send({ t: "done", fid: id })) {
          this.answer(id, { t: "reject", e: "offline" });
          return fail("offline");
        }
        doneSent = true;
        this.setTransfer(id, { state: "saving" });
        const r = await saved;
        if (!r) return fail("timeout");
        if (r.t === "reject") {
          // The PC already removed the objects and freed its slot.
          offered = null;
          return fail(rejectCode(r.e));
        }
        this.setTransfer(id, { state: "saved", done: plan.size });
        return { ok: true, d: { fid: id } };
      }
      this.setTransfer(id, { state: "uploading" });
      offered = plan;
      await this.withMembership(async (b) => {
        await uploadFile(b, crypto, d.topic, file, plan, progress);
        await uploadMailbox(b, d.topic, id, this.mailboxObject(d, plan.fid, offerOf(plan)));
      });
      this.setTransfer(id, { state: "queued", done: plan.size });
      return { ok: true, d: { fid: id, queued: true } };
    } catch (e) {
      return fail(xferCode(e));
    }
  }

  async getFile(fid: string): Promise<File | null> {
    const f = this.snap.files.find((x) => x.fid === fid);
    const blob = f && (await this.o.files?.get(fid));
    return f && blob ? new File([blob], f.name, { type: f.mime }) : null;
  }

  async removeFile(fid: string) {
    const files = this.snap.files.filter((f) => f.fid !== fid);
    this.set({ files });
    await this.o.files?.remove(fid).catch(() => {});
    await this.o.store.saveFiles(files).catch(() => {});
  }

  private markProcessed(fid: string) {
    this.processed = { ...this.processed, [fid]: Math.floor(this.now() / 1000) };
    void this.o.store.saveProcessed(this.processed).catch(() => {});
  }

  /** Checks shared by live and mailbox offers from the PC. */
  private checkOffer(raw: unknown): { plan: Plan } | { e: XferError; fid?: string } {
    const plan = planOf(raw);
    const fid = (raw as { fid?: unknown })?.fid;
    if (!plan) return { e: "invalid", fid: isFid(fid) ? fid : undefined };
    if (!this.device?.perms.filesOut) return { e: "denied", fid: plan.fidHex };
    if (plan.size > MAX_RECEIVE_BYTES) return { e: "tooBig", fid: plan.fidHex };
    if (!this.o.files || !this.o.blobs) return { e: "unsupported", fid: plan.fidHex };
    if (this.incoming.has(plan.fidHex)) return { e: "invalid", fid: plan.fidHex };
    if (this.incoming.size >= MAX_INCOMING) return { e: "busy", fid: plan.fidHex };
    return { plan };
  }

  /** Downloads a PC-to-phone file into the shelf, then tells the PC and cleans the relay up. */
  private async receive(plan: Plan, mailbox: boolean) {
    const d = this.device;
    const crypto = this.o.files;
    if (!d || !crypto) return;
    const id = plan.fidHex;
    const entry = this.incoming.get(id);
    if (entry) entry.started = true;
    if (!this.snap.transfers.some((t) => t.id === id)) this.addTransfer({ id, dir: "c2p", name: plan.name, size: plan.size, done: 0, state: "downloading", at: this.now() });
    else this.setTransfer(id, { state: "downloading" });
    try {
      await this.withMembership((b) => receiveFile(b, crypto, d.topic, plan, (done) => this.setTransfer(id, { done })));
    } catch (e) {
      const code = xferCode(e);
      this.incoming.delete(id);
      this.afterIncoming();
      this.setTransfer(id, { state: "failed", e: code });
      if (!mailbox) this.sendOrKeep(id, { t: "reject", fid: id, e: code });
      if (!(mailbox && (code === "network" || code === "offline" || code === "storage"))) {
        if (mailbox) this.markProcessed(id);
        await this.withMembership((b) => discard(b, d.topic, "c2p", id, plan.chunks, mailbox)).catch(() => {});
      }
      return;
    }
    this.incoming.delete(id);
    this.afterIncoming();
    const files = [{ fid: id, name: plan.name, size: plan.size, mime: plan.mime, at: this.now() }, ...this.snap.files.filter((f) => f.fid !== id)];
    this.set({ files });
    await this.o.store.saveFiles(files).catch(() => {});
    if (mailbox) this.markProcessed(id);
    else this.sendOrKeep(id, { t: "saved", fid: id });
    this.setTransfer(id, { state: "ready", done: plan.size });
    await this.withMembership((b) => discard(b, d.topic, "c2p", id, plan.chunks, mailbox)).catch(() => {});
  }

  private afterIncoming() {
    if (!this.rescanWanted) return;
    this.rescanWanted = false;
    void this.scanMailbox(this.gen);
  }

  /** Reads the PC's mailbox for this phone (`<topic>/mbox/c2p`), design 7.4. */
  private async scanMailbox(g: number) {
    const d = this.device;
    if (!d || !this.o.blobs) return;
    if (this.scanning) {
      this.scanAgain = true;
      return;
    }
    this.scanning = true;
    try {
      await this.withMembership(async (b) => {
        const names = (await b.list(mboxPrefix(d.topic, "c2p"))).filter((f) => isFid(f) && !this.incoming.has(f));
        for (const fid of names.slice(0, 20)) {
          if (g !== this.gen || this.device !== d) return;
          if (this.processed[fid]) {
            // Handled before: only a leftover (or a replay) of an item already delivered.
            await discard(b, d.topic, "c2p", fid, 0, true).catch(() => {});
            continue;
          }
          const bytes = await b.get(mboxPath(d.topic, "c2p", fid)).catch(() => null);
          if (!bytes) continue;
          const keys: [number, string | undefined][] = [[d.ep, d.kDev], [d.epPrev ?? -1, d.kPrev]];
          const keyFor = (ep: number) => {
            const k = keys.find(([e]) => e === ep)?.[1];
            return k ? unb64uLen(k, 32) : null;
          };
          const inner = openMailbox(keyFor, d.topic, "c2p", unhex(fid)!, bytes, Math.floor(this.now() / 1000));
          if (inner?.t === "text" && typeof inner.text === "string" && inner.text && inner.text.length <= MAX_TEXT) {
            this.set({ inbox: [{ id: ++this.inboxId, text: inner.text, at: this.now() }, ...this.snap.inbox].slice(0, 20) });
          } else if (inner?.t === "clip") {
            const m = parsePcMessage(inner);
            if (m?.t === "clip") this.takeClip(m.text, m.at, false);
          } else if (inner?.t === "offer") {
            const r = this.checkOffer(inner);
            if ("plan" in r && r.plan.fidHex === fid) {
              this.incoming.set(fid, { plan: r.plan, mailbox: true });
              void this.receive(r.plan, true);
              continue;
            }
            // Full right now: the item stays in the mailbox until a transfer ends.
            if ("e" in r && r.e === "busy") {
              this.rescanWanted = true;
              continue;
            }
            this.markProcessed(fid);
            await discard(b, d.topic, "c2p", fid, "plan" in r ? 0 : (planOf(inner)?.chunks ?? 0), true).catch(() => {});
            continue;
          }
          this.markProcessed(fid);
          await discard(b, d.topic, "c2p", fid, 0, true).catch(() => {});
        }
      });
    } catch {
      /* the next session start scans again */
    } finally {
      this.scanning = false;
      if (this.scanAgain && g === this.gen) {
        this.scanAgain = false;
        void this.scanMailbox(g);
      }
    }
  }

  /**
   * PC clipboard text: replaces the older one in the inbox. Only a copy made while this page was
   * open (`fresh`) is written to the phone clipboard, once, as it arrives; a copy that waited
   * (mailbox, hidden page, sent again at a session start) is offered, since the phone clipboard
   * may hold something newer by then.
   */
  private takeClip(text: string, at: number, fresh: boolean) {
    // The same copy again (the PC resends one the phone may not have got): shown once, and a
    // dismissed one stays gone.
    if (at === this.clipAt && text === this.clipText) return;
    if (at < this.clipFloor) return;
    this.clipAt = at;
    this.clipText = text;
    // A PC clock far ahead (later corrected) must not hide every copy after it.
    this.clipFloor = at <= this.now() + CLIP_SKEW_MS ? at : this.now();
    const item: InboxItem = { id: ++this.inboxId, text, at: this.now(), clip: true };
    this.clipAuto = fresh && this.visible ? item.id : null;
    this.set({ inbox: [item, ...this.snap.inbox.filter((i) => !i.clip)].slice(0, 20) });
    if (this.clipAuto !== null) void this.writeClip();
  }

  /** One write at a time, each for the newest copy when its turn comes, so an older write cannot finish last. */
  private writeClip() {
    this.clipWrites = this.clipWrites.then(() => this.writeClipNow()).catch(() => {});
    return this.clipWrites;
  }

  private async writeClipNow() {
    const item = this.snap.inbox.find((i) => i.clip);
    const cb = this.o.clipboard;
    if (!item || !cb || this.clipAuto !== item.id) return;
    // One try: a refused copy stays offered with Copy.
    this.clipAuto = null;
    if (!this.visible || !(await cb.write(item.text).catch(() => false))) return;
    this.set({ inbox: this.snap.inbox.map((i) => (i.id === item.id ? { ...i, copied: true } : i)) });
  }

  dismissInbox(id: number) {
    this.set({ inbox: this.snap.inbox.filter((i) => i.id !== id) });
  }

  /** "Forget this PC": tells the PC to remove the device when online, then wipes the phone. */
  async forget() {
    if (this.snap.conn === "online") {
      this.send({ t: "unpair" });
      await new Promise((r) => setTimeout(r, 400));
    }
    this.stop();
    this.device = null;
    this.clipAt = this.clipFloor = -1;
    this.clipText = "";
    this.clipAuto = null;
    await this.o.store.saveDevice(null);
    for (const f of this.snap.files) await this.o.files?.remove(f.fid).catch(() => {});
    await this.o.store.saveFiles([]).catch(() => {});
    this.set({ device: null, status: null, inbox: [], pairing: null, conn: "idle", transfers: [], files: [] });
  }

  // Pairing (design 5.2, phone side).

  async pair(qr: Qr) {
    this.stop();
    const g = this.gen;
    this.set({ pairing: { step: "joining", pcName: qr.pcName, expiresAt: qr.expiresAt }, status: null });
    const fail = (error: PairError) => {
      if (g !== this.gen || this.pairing?.done) return;
      this.pairing = null;
      this.teardown();
      this.set({ pairing: { step: "error", pcName: qr.pcName, expiresAt: qr.expiresAt, error } });
    };
    const expiry = setTimeout(() => fail("expired"), Math.max(0, qr.expiresAt * 1000 - this.now()));
    try {
      const auth = await this.ensureAuth();
      if (g !== this.gen) return;
      const p = new Pairing(qr, auth.userId, this.o.identity().name, this.o.identity().ua);
      this.pairing = { p, done: false };
      const ch = this.openChannel(g, () => fail("network"));
      try {
        await ch.join(p.topic, auth.accessToken);
      } catch (e) {
        // No live offer for this topic any more: cancelled, used or expired on the PC.
        fail(e instanceof JoinError && e.kind === "unauthorized" ? "expired" : "network");
        return;
      }
      if (g !== this.gen) return;
      this.set({ pairing: { step: "code", pcName: qr.pcName, expiresAt: qr.expiresAt, code: p.code } });
      while (g === this.gen && this.pairing && !this.pairing.done) {
        await ch.send(p.topic, "hello", p.hello()).catch(() => {});
        await this.sleep(this.t.helloEveryMs, g);
      }
    } catch (e) {
      fail(e instanceof RelayError && e.kind === "paused" ? "paused" : "network");
    } finally {
      clearTimeout(expiry);
    }
  }

  cancelPairing() {
    this.pairing = null;
    this.stop();
    this.set({ pairing: null });
    if (this.device) void this.run();
  }

  private async onWelcome(g: number, payload: unknown) {
    const pr = this.pairing;
    if (!pr || pr.done) return;
    const w = pr.p.openWelcome(payload);
    if (!w) return;
    pr.done = true;
    const rec = deviceRecord(pr.p, w, Math.floor(this.now() / 1000));
    await this.o.store.saveDevice(rec);
    if (g !== this.gen) return;
    this.device = rec;
    this.showDevice();
    this.set({ pairing: { ...this.snap.pairing!, step: "done" } });
    this.o.onPaired?.();
    this.ch?.leave(pr.p.topic);
    this.pairing = null;
    this.stop();
    void this.run();
  }

  /** Clears the "paired" confirmation once the UI has shown it. */
  clearPairingView() {
    if (this.snap.pairing?.step === "done" || this.snap.pairing?.step === "error") this.set({ pairing: null });
  }

  // Connection loop.

  private async run() {
    const g = ++this.gen;
    let delay = this.t.retryMinMs;
    while (g === this.gen && this.device) {
      try {
        const closed = await this.connectOnce(g);
        delay = this.t.retryMinMs;
        await closed;
      } catch (e) {
        if (e instanceof Revoked) {
          if (g === this.gen) {
            this.teardown();
            this.setConn("revoked");
          }
          return;
        }
        if (g === this.gen) this.setConn(e instanceof RelayError && e.kind === "paused" ? "paused" : "offline");
      }
      if (g !== this.gen) return;
      this.teardown();
      if (this.snap.conn !== "paused") this.setConn("offline");
      await this.sleep(delay + Math.random() * delay * 0.3, g);
      delay = Math.min(delay * 2, this.t.retryMaxMs);
    }
  }

  /** Connects and starts the handshake; resolves with a promise that settles when the socket closes. */
  private async connectOnce(g: number): Promise<Promise<void>> {
    this.setConn("connecting");
    const auth = await this.ensureAuth();
    if (g !== this.gen) return Promise.resolve();
    let onClosed!: () => void;
    const closed = new Promise<void>((r) => (onClosed = r));
    const ch = this.openChannel(g, onClosed);
    const topic = this.device!.topic;
    try {
      await ch.join(topic, auth.accessToken);
    } catch (e) {
      if (!(e instanceof JoinError) || e.kind !== "unauthorized") throw e;
      // Our anonymous user is not the topic's phone member (lost session): rejoin with K_rejoin.
      await this.rejoin();
      if (g !== this.gen) return Promise.resolve();
      await ch.join(topic, this.auth!.accessToken);
    }
    if (g !== this.gen) return Promise.resolve();
    this.hsFailures = 0;
    void this.scanMailbox(g);
    this.startSession();
    this.pingTimer = setInterval(() => {
      if (this.visible && this.snap.conn === "online") this.send({ t: "ping" });
    }, this.t.pingMs);
    return closed;
  }

  private openChannel(g: number, onClosed: () => void): Channel {
    this.ch?.close();
    const ch = this.o.channel();
    this.ch = ch;
    ch.onBroadcast = (topic, event, payload) => {
      if (g === this.gen && this.ch === ch) this.onBroadcast(g, topic, event, payload);
    };
    ch.onClose = () => {
      if (this.ch === ch) this.ch = null;
      onClosed();
    };
    return ch;
  }

  private teardown() {
    if (this.hsTimer) clearTimeout(this.hsTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.hsTimer = this.pingTimer = this.refreshTimer = null;
    this.endSession();
    const ch = this.ch;
    this.ch = null;
    ch?.close();
  }

  private sleep(ms: number, g: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (g === this.gen) this.wake = done;
      else done();
    });
  }

  // Relay auth (design 5.3).

  private async ensureAuth(): Promise<AuthSession> {
    const now = Math.floor(this.now() / 1000);
    let auth = this.auth;
    if (auth && auth.expiresAt - now > this.t.refreshBeforeSecs) {
      this.scheduleRefresh(auth);
      return auth;
    }
    if (auth) {
      try {
        auth = await this.o.rest.refresh(auth.refreshToken, now);
      } catch (e) {
        // Only a refresh token Auth says is used or revoked starts a new anonymous user (and a
        // rejoin later); anything else (429, 5xx) is retried with the normal backoff.
        if (!deadRefreshToken(e)) throw e;
        auth = null;
      }
    }
    if (!auth) auth = await this.o.rest.signupAnonymous(now);
    this.auth = auth;
    await this.o.store.saveAuth(auth);
    this.ch?.setToken(auth.accessToken);
    this.scheduleRefresh(auth);
    return auth;
  }

  private scheduleRefresh(auth: AuthSession) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const ms = (auth.expiresAt - this.t.refreshBeforeSecs) * 1000 - this.now() + 1000;
    const g = this.gen;
    this.refreshTimer = setTimeout(() => {
      if (g === this.gen) this.ensureAuth().catch(() => this.ch?.close());
    }, Math.max(5_000, Math.min(ms, 2_000_000_000)));
  }

  private async rejoin() {
    const d = this.device!;
    const auth = this.auth!;
    const kRejoin = unb64uLen(d.kRejoin, 32);
    if (!kRejoin) throw new Revoked();
    const ts = Math.floor(this.now() / 1000);
    try {
      await this.o.rest.rpc(auth.accessToken, "link_rejoin", { t: d.topic, ts, mac: bytea(rejoinMac(kRejoin, d.topic, auth.userId, ts)) });
    } catch (e) {
      // `bad mac` with a correct key means the topic is gone: the PC removed this phone.
      if (e instanceof RelayError && e.kind === "status" && /bad mac/.test(e.message)) throw new Revoked();
      throw e;
    }
  }

  // Session (design 6.1, appendix B).

  private endSession() {
    const old = this.session;
    old?.close();
    this.session = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, e: "offline" });
    }
    this.pending.clear();
    for (const [fid, w] of this.waiters) {
      if (w.session && w.session === old) {
        clearTimeout(w.timer);
        this.waiters.delete(fid);
        w.resolve(null);
      }
    }
    // A live offer whose `done` never came: the PC moves it to the mailbox, so free the slot.
    for (const [fid, x] of this.incoming) {
      if (x.mailbox || x.started) continue;
      this.incoming.delete(fid);
      this.setTransfer(fid, { state: "failed", e: "offline" });
    }
    // Asks belong to the PC's run that sent them; nothing from an old session stays answerable.
    const st = this.snap.status;
    if (st?.asks?.length || st?.asksMore) this.set({ status: { ...st, asks: [], asksMore: undefined } });
  }

  private startSession() {
    const d = this.device;
    const ch = this.ch;
    if (!d || !ch) return;
    const kDev = unb64uLen(d.kDev, 32);
    if (!kDev) return;
    this.endSession();
    const s = new Session(d.topic, kDev, d.ep);
    this.session = s;
    if (this.snap.conn !== "waiting") this.setConn("handshake");
    if (this.hsTimer) clearTimeout(this.hsTimer);
    void ch.send(d.topic, "hs1", s.hs1(Math.floor(this.now() / 1000))).catch(() => {});
    this.lastOut = this.now();
    this.hsTimer = setTimeout(() => {
      if (this.session !== s || s.ready) return;
      this.hsFailures++;
      this.setConn("waiting");
      const wait = Math.min(this.t.retryMinMs * 2 ** Math.min(this.hsFailures, 6), 60_000);
      this.hsTimer = setTimeout(() => {
        if (this.session === s) this.startSession();
      }, wait);
    }, this.t.hs2Ms);
  }

  private onBroadcast(g: number, topic: string, event: string, payload: unknown) {
    if (this.pairing && topic === this.pairing.p.topic) {
      if (event === "welcome") void this.onWelcome(g, payload);
      return;
    }
    const s = this.session;
    if (!s || !this.device || topic !== this.device.topic) return;
    if (event === "hs2") {
      if (!s.onHs2(payload)) return;
      if (this.hsTimer) clearTimeout(this.hsTimer);
      this.hsTimer = null;
      this.hsFailures = 0;
      this.setConn("online");
      for (const [fid, inner] of this.unsent) if (this.send(inner)) this.unsent.delete(fid);
      void this.scanMailbox(g);
    } else if (event === "m") {
      const inner = s.open(payload);
      // One at a time: a perms save must not overwrite a rekey save with the old key.
      if (inner) this.inbound = this.inbound.then(() => this.onMessage(s, inner)).catch(() => {});
    }
  }

  private async onMessage(s: Session, inner: Record<string, unknown>) {
    const msg = parsePcMessage(inner);
    if (!msg) return;
    switch (msg.t) {
      case "res": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg.ok ? { ok: true, d: msg.d } : { ok: false, e: msg.e });
        return;
      }
      case "status":
        if (msg.d.maxInMb) this.pcMaxIn = Math.min(msg.d.maxInMb * 1024 * 1024, MAX_SEND_BYTES);
        this.set({ status: msg.d });
        return;
      case "perms":
        if (this.device) {
          this.device = { ...this.device, perms: msg.d };
          await this.o.store.saveDevice(this.device);
          this.showDevice();
        }
        return;
      case "text":
        this.set({ inbox: [{ id: ++this.inboxId, text: msg.text, at: this.now() }, ...this.snap.inbox].slice(0, 20) });
        return;
      case "clip":
        this.takeClip(msg.text, msg.at, !msg.late);
        return;
      case "rekey": {
        // Only the current session may ratchet, and the key is stored before `rekeyed` goes out.
        const next = s.nextKey(msg.ep);
        if (!next || !this.device || this.session !== s) return;
        // The previous key stays for mailbox items only: the PC may not have confirmed the new one yet.
        const rec = { ...this.device, kDev: b64u(next.kDev), ep: next.ep, kPrev: this.device.kDev, epPrev: this.device.ep };
        await this.o.store.saveDevice(rec);
        next.kDev.fill(0);
        if (!this.device || this.device.id !== rec.id) return;
        this.device = rec;
        if (this.session === s) this.send({ t: "rekeyed", ep: next.ep });
        return;
      }
      case "bye":
        if (this.session !== s) return;
        this.endSession();
        if (this.hsTimer) clearTimeout(this.hsTimer);
        this.setConn("ended");
        return;
      case "relink":
        // The PC lost the relay and dropped this session; it is back, so start a new one.
        if (this.session === s && this.snap.conn === "online") this.startSession();
        return;
      case "reject":
        if (this.incoming.has(msg.fid)) {
          this.incoming.delete(msg.fid);
          this.setTransfer(msg.fid, { state: "failed", e: rejectCode(msg.e) });
        }
        this.answer(msg.fid, { t: "reject", e: msg.e });
        return;
      case "accept":
      case "saved":
        this.answer(msg.fid, { t: msg.t });
        return;
      case "offer": {
        // The PC offers its open files again on every new session.
        const fid = (msg.offer as { fid?: unknown })?.fid;
        if (isFid(fid) && this.incoming.has(fid)) return;
        if (isFid(fid) && this.snap.files.some((f) => f.fid === fid)) {
          this.send({ t: "saved", fid });
          return;
        }
        const r = this.checkOffer(msg.offer);
        if (!("plan" in r)) {
          if (r.fid) this.send({ t: "reject", fid: r.fid, e: r.e });
          return;
        }
        this.incoming.set(r.plan.fidHex, { plan: r.plan, mailbox: false });
        this.addTransfer({ id: r.plan.fidHex, dir: "c2p", name: r.plan.name, size: r.plan.size, done: 0, state: "incoming", at: this.now() });
        this.send({ t: "accept", fid: r.plan.fidHex });
        return;
      }
      case "done": {
        const x = this.incoming.get(msg.fid);
        // Not awaited: a long download must not hold up the messages behind it.
        if (x && !x.mailbox && !x.started) void this.receive(x.plan, false);
        else if (!x) {
          // An offer this phone no longer holds: say so, so the PC frees it instead of waiting 2 h.
          const have = this.snap.files.some((f) => f.fid === msg.fid);
          this.send(have ? { t: "saved", fid: msg.fid } : { t: "reject", fid: msg.fid, e: "expired" });
        }
        return;
      }
    }
  }

  private sendOrKeep(fid: string, inner: object) {
    if (this.send(inner)) return;
    this.unsent.delete(fid);
    this.unsent.set(fid, inner);
    while (this.unsent.size > 32) this.unsent.delete(this.unsent.keys().next().value!);
  }

  private send(inner: object): boolean {
    const s = this.session;
    const ch = this.ch;
    if (!s?.ready || !ch || !this.device) return false;
    void ch.send(this.device.topic, "m", s.seal(inner)).catch(() => {});
    this.lastOut = this.now();
    return true;
  }

  private nextReq() {
    this.nextId = (this.nextId % 0xfffffffe) + 1;
    return this.nextId;
  }

  private request(id: number, inner: object): Promise<Result> {
    // The PC drops a larger envelope without a reply; refuse it here instead of timing out.
    if (utf8(JSON.stringify(inner)).length > MAX_INNER) return Promise.resolve({ ok: false, e: "tooLong" });
    if (this.snap.conn !== "online") return Promise.resolve({ ok: false, e: "offline" });
    return new Promise((resolve) => {
      const s = this.session;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, e: "timeout" });
        // No reply: the PC dropped this session (idle expiry or restart). Start a new one.
        if (this.session === s && this.snap.conn === "online") this.startSession();
      }, this.t.resMs);
      this.pending.set(id, { resolve, timer });
      if (!this.send(inner)) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, e: "offline" });
      }
    });
  }
}

function xferCode(e: unknown): XferError {
  if (e instanceof BlobError) return e.code;
  if (e instanceof RelayError) return e.kind === "status" ? "invalid" : "network";
  return "io";
}

const REJECT_CODES = new Set<string>(["denied", "tooBig", "disk", "invalid", "busy", "network", "corrupt", "io", "expired", "storage", "unsupported", "folder"]);
const rejectCode = (e: string): XferError => (REJECT_CODES.has(e) ? (e as XferError) : "invalid");

function deadRefreshToken(e: unknown): boolean {
  return e instanceof RelayError && e.kind === "status" && (e.status === 400 || e.status === 401) && /refresh.?token|invalid_grant/i.test(e.message);
}

/** What the UI uses; the demo build supplies its own. */
export type LinkApi = Pick<
  Link,
  | "snapshot"
  | "subscribe"
  | "start"
  | "stop"
  | "setVisible"
  | "leave"
  | "reconnect"
  | "command"
  | "sendText"
  | "sendFile"
  | "dismissTransfer"
  | "getFile"
  | "removeFile"
  | "dismissInbox"
  | "forget"
  | "pair"
  | "cancelPairing"
  | "clearPairingView"
>;
