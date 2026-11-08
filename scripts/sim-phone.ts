// Simulated phone: runs the PWA's own protocol code (src/core) without a browser, driven by
// the Rust tests in src-tauri/src/phone_link/pwa_interop.rs.
//
//   bun scripts/sim-phone.ts --relay "<qr url>"   talks to the real Supabase relay
//   bun scripts/sim-phone.ts --stdio "<qr url>"   the Rust test is the relay and the bucket:
//                                                 JSON lines on stdin/stdout
//
// Prints JSON lines: {op:"code"} for the PC to type, then one line per step, {op:"done"} at the end.
// The steps: pairing, a command, status, text both ways, a file both ways, the ratchet, a
// second session, then mailbox delivery both ways while the phone is closed ({op:"queued"},
// the PC answers {op:"go"} once it has queued its own text). PC clipboard copies (T-016) come
// once live after the PC's text and once through the mailbox.

import { createInterface } from "node:readline";
import config from "../relay.config.json";
import { b64u, unb64u, utf8 } from "../src/core/bytes";
import { Link, type ReceivedFile, type Snapshot, type Store } from "../src/core/link";
import { parseQr, type DeviceRecord } from "../src/core/protocol";
import { type AuthSession, type Channel, Realtime, RelayBlobs, Rest } from "../src/core/relay";
import { BlobError, type Blobs, type Dir, InlineCrypto, mboxPrefix, type XferError } from "../src/core/transfer";

const [mode, url] = process.argv.slice(2);
if ((mode !== "--relay" && mode !== "--stdio") || !url) {
  console.error("usage: sim-phone.ts --relay|--stdio <qr url>");
  process.exit(2);
}

const out = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
const fail = (why: string) => {
  out({ op: "error", why });
  process.exit(1);
};
setTimeout(() => fail("overall timeout"), 150_000).unref?.();

class MemStore implements Store {
  device: DeviceRecord | null = null;
  auth: AuthSession | null = null;
  files: ReceivedFile[] = [];
  processed: Record<string, number> = {};
  async load() {
    return { device: this.device, auth: this.auth };
  }
  async saveDevice(d: DeviceRecord | null) {
    this.device = d;
  }
  async saveAuth(a: AuthSession | null) {
    this.auth = a;
  }
  async loadFiles() {
    return { files: this.files, processed: this.processed };
  }
  async saveFiles(f: ReceivedFile[]) {
    this.files = f;
  }
  async saveProcessed(p: Record<string, number>) {
    this.processed = p;
  }
}

// --stdio: every channel shares stdin; the Rust side plays relay and PC.
const stdioChannels = new Set<StdioChannel>();
class StdioChannel implements Channel {
  onBroadcast: Channel["onBroadcast"] = () => {};
  onClose: Channel["onClose"] = () => {};
  joined = new Set<string>();
  constructor() {
    stdioChannels.add(this);
  }
  async join(topic: string) {
    this.joined.add(topic);
    out({ op: "join", topic });
  }
  leave(topic: string) {
    this.joined.delete(topic);
  }
  async send(topic: string, event: string, payload: unknown) {
    out({ op: "send", topic, event, payload });
  }
  setToken() {}
  close() {
    if (stdioChannels.delete(this)) this.onClose();
  }
}

const SIM_UID = "00000000-0000-4000-8000-00000000c0de";
class StdioRest {
  async signupAnonymous(now: number): Promise<AuthSession> {
    return { accessToken: "sim", refreshToken: "sim", expiresAt: now + 3600, userId: SIM_UID };
  }
  async refresh(_r: string, now: number) {
    return this.signupAnonymous(now);
  }
  async rpc() {
    return null;
  }
}

// --stdio: the bucket is the Rust test's in-memory one; calls go out as {op:"blob"} lines.
const blobCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let blobId = 0;
function blobCall(call: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++blobId;
    blobCalls.set(id, { resolve, reject });
    out({ op: "blob", id, call, args });
  });
}
class StdioBlobs implements Blobs {
  async authorize(topic: string, dir: Dir, fid: string, count: number, kind: "blob" | "mailbox") {
    return (await blobCall("authorize", [topic, dir, fid, count, kind])) as string[];
  }
  async put(u: string, body: Uint8Array) {
    await blobCall("put", [u, b64u(body)]);
  }
  async get(path: string) {
    return unb64u(await blobCall("get", [path]))!;
  }
  async delete(paths: string[]) {
    await blobCall("delete", [paths]);
  }
  async release(topic: string, dir: Dir, fid: string, kind: string) {
    await blobCall("release", [topic, dir, fid, kind]);
  }
  async list(prefix: string) {
    return (await blobCall("list", [prefix])) as string[];
  }
}

let go: () => void = () => {};
const goSignal = new Promise<void>((r) => (go = r));

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let m: { op?: string; topic?: string; event?: string; payload?: unknown; id?: number; ok?: boolean; r?: unknown; e?: string };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.op === "go") go();
    if (m.op === "broadcast" && m.topic && m.event) for (const ch of stdioChannels) if (ch.joined.has(m.topic)) ch.onBroadcast(m.topic, m.event, m.payload);
    if (m.op === "blobres" && m.id) {
      const c = blobCalls.get(m.id);
      blobCalls.delete(m.id);
      if (m.ok) c?.resolve(m.r);
      else c?.reject(new BlobError((m.e as XferError) ?? "network"));
    }
  })
  .on("close", () => process.exit(0));

const store = new MemStore();
const files = new InlineCrypto();
const link = new Link({
  store,
  rest: (mode === "--relay" ? new Rest(config) : new StdioRest()) as Rest,
  channel: () => (mode === "--relay" ? new Realtime(config) : new StdioChannel()),
  identity: () => ({ name: "Sim phone", ua: "bun sim-phone" }),
  blobs: (token) => (mode === "--relay" ? new RelayBlobs(config, token) : new StdioBlobs()),
  files,
});

function waitFor(cond: (s: Snapshot) => boolean, what: string, ms = 45_000): Promise<Snapshot> {
  return new Promise((resolve) => {
    const check = () => {
      const s = link.snapshot();
      if (s.pairing?.step === "error") fail(`pairing ${s.pairing.error}`);
      if (s.conn === "revoked") fail("revoked");
      if (cond(s)) {
        clearTimeout(timer);
        unsub();
        resolve(s);
      }
    };
    const timer = setTimeout(() => fail(`timeout: ${what} (conn ${link.snapshot().conn})`), ms);
    const unsub = link.subscribe(check);
    check();
  });
}

const now = Math.floor(Date.now() / 1000);
const qr = parseQr(new URL(url).hash, config.ref, now);
if (typeof qr === "string") fail(`qr ${qr}`);
else {
  void link.pair(qr);
  const s = await waitFor((s) => s.pairing?.step === "code", "code");
  out({ op: "code", code: s.pairing!.code });
  await waitFor((s) => s.conn === "online", "online");
  out({ op: "online", ep: store.device!.ep });

  out({ op: "res", cmd: "media.play_pause", r: await link.command("media.play_pause") });
  out({ op: "res", cmd: "status.get", r: await link.command("status.get") });
  out({ op: "res", cmd: "text", r: await link.sendText("hello from the pwa") });
  const inbox = await waitFor((s) => s.inbox.some((i) => !i.clip), "text from the pc");
  out({ op: "text", text: inbox.inbox.find((i) => !i.clip)!.text });
  const live = await waitFor((s) => s.inbox.some((i) => i.clip), "live clipboard copy from the pc");
  out({ op: "clip-live", text: live.inbox.find((i) => i.clip)!.text });

  // A file both ways over the live session.
  out({ op: "res", cmd: "file", r: await link.sendFile(new File([utf8("file from the pwa")], "sim note.txt", { type: "text/plain" })) });
  const got = await waitFor((s) => s.files.length > 0, "file from the pc");
  const blob = await files.get(got.files[0].fid);
  out({ op: "file", name: got.files[0].name, text: blob ? await blob.text() : null });

  await waitFor(() => store.device!.ep === 1, "rekey to epoch 1");
  out({ op: "ep", ep: store.device!.ep });

  // A new session must handshake under the ratcheted key.
  link.reconnect();
  await waitFor((s) => s.conn === "online", "second session");
  out({ op: "res", cmd: "status.get#2", r: await link.command("status.get") });

  // Mailbox: the phone is closed, so both sides queue on the relay.
  link.stop();
  out({ op: "res", cmd: "queued-text", r: await link.sendText("mailbox from the pwa") });
  out({ op: "queued" });
  await goSignal;
  await link.start();
  const mbox = await waitFor((s) => s.inbox.some((i) => i.text === "mailbox from the pc"), "mailbox text from the pc");
  out({ op: "mailbox", text: mbox.inbox.find((i) => i.text === "mailbox from the pc")!.text });
  const clip = await waitFor((s) => s.inbox.some((i) => i.clip && i.text === "clip from the pc"), "mailbox clipboard copy from the pc");
  out({ op: "clip-mailbox", text: "clip from the pc", clips: clip.inbox.filter((i) => i.clip).length });
  // The inbox shows the text before the scan deletes the item (and the newest copy may come live
  // first); a page stays open, the sim must wait.
  {
    const b = mode === "--relay" ? new RelayBlobs(config, () => store.auth!.accessToken) : new StdioBlobs();
    const until = Date.now() + 15_000;
    while ((await b.list(mboxPrefix(store.device!.topic, "c2p")).catch(() => ["?"])).length && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  }
  link.stop();
  out({ op: "done" });
  process.exit(0);
}
