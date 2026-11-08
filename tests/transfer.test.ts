import { expect, test } from "bun:test";
import { hex, randomBytes, utf8 } from "../src/core/bytes";
import * as c from "../src/core/crypto";
import { Link } from "../src/core/link";
import { parseQr } from "../src/core/protocol";
import type { Rest } from "../src/core/relay";
import { RelayBlobs, signedUploadUrl } from "../src/core/relay";
import {
  BlobError,
  blobPath,
  CHUNK,
  chunkCount,
  InlineCrypto,
  MAILBOX_MAX_AGE,
  mboxPath,
  newPlan,
  offerOf,
  openChunk,
  openMailbox,
  planOf,
  receiveFile,
  sanitizeName,
  sealChunk,
  sealMailbox,
  uploadFile,
} from "../src/core/transfer";
import { Bus, CFG, FakeChannel, FakePc, FakeRest, MemBlobs, MemoryStore, until } from "./fakes";

const FAST = { hs2Ms: 60, resMs: 80, pingMs: 10_000, helloEveryMs: 30, retryMinMs: 20, retryMaxMs: 40, acceptMs: 500, savedMs: 2000 };
const ALL = { media: true, status: true, volume: true, textIn: true, textOut: true, filesIn: true, filesOut: true, clipboard: true };
const sha = (b: Uint8Array) => c.sha256(b);

function setup(store = new MemoryStore()) {
  const bus = new Bus();
  const pc = new FakePc(bus);
  const blobs = new MemBlobs();
  const files = new InlineCrypto();
  const link = new Link({
    store,
    rest: new FakeRest() as unknown as Rest,
    channel: () => new FakeChannel(bus),
    identity: () => ({ name: "Galaxy S26", ua: "Android Chrome" }),
    timing: FAST,
    blobs: () => blobs,
    files,
  });
  return { bus, pc, link, store, blobs, files };
}

async function paired(perms: Record<string, unknown> = ALL) {
  const t = setup();
  const now = Math.floor(Date.now() / 1000);
  const qr = parseQr(t.pc.qrHash(now + 300), CFG.ref, now);
  if (typeof qr === "string") throw new Error(qr);
  void t.link.pair(qr);
  await until(() => t.pc.code !== "");
  t.pc.welcome(perms);
  await until(() => t.link.snapshot().conn === "online");
  return t;
}

/** What the PC uploads for a PC-to-phone file. */
function pcUpload(blobs: MemBlobs, topic: string, name: string, data: Uint8Array) {
  const plan = newPlan(name, data.length, "application/pdf", sha(data))!;
  for (let i = 0; i < plan.chunks; i++) blobs.objects.set(blobPath(topic, "c2p", plan.fidHex, i), sealChunk(plan, "c2p", i, data.slice(i * CHUNK, (i + 1) * CHUNK)));
  return plan;
}

test("names, offers and chunks are checked like on the PC", () => {
  expect(sanitizeName("../../evil.exe")).toBe("evil.exe");
  expect(sanitizeName("a<b>c?.txt")).toBe("abc.txt");
  expect(sanitizeName(" .. ")).toBe("file");
  expect(sanitizeName(".gitignore")).toBe(".gitignore");
  expect(sanitizeName("  .env. ")).toBe(".env");
  expect(sanitizeName("invoice‮gpj.exe")).toBe("invoicegpj.exe");
  expect(Array.from(sanitizeName("x".repeat(300) + ".jpeg")).length).toBe(120);
  expect([chunkCount(0), chunkCount(CHUNK), chunkCount(CHUNK + 1), chunkCount(64 * CHUNK + 1)]).toEqual([1, 1, 2, null]);
  const plan = newPlan("a.bin", 9 * 1024 * 1024, "application/x", new Uint8Array(32))!;
  const back = planOf(offerOf(plan))!;
  expect(back.fidHex).toBe(plan.fidHex);
  expect(hex(back.key)).toBe(hex(plan.key));
  expect(planOf({ ...offerOf(plan), chunks: 2 })).toBeNull();
  expect(planOf({ ...offerOf(plan), extra: 1 })).toBeNull();
  expect(planOf({ ...offerOf(plan), key: "short" })).toBeNull();
  const small = newPlan("x", CHUNK + 5, "a/b", new Uint8Array(32))!;
  const c0 = sealChunk(small, "c2p", 0, new Uint8Array(CHUNK));
  expect(openChunk(small, "c2p", 0, c0)).not.toBeNull();
  expect(openChunk(small, "c2p", 1, c0)).toBeNull();
  expect(openChunk(small, "p2c", 0, c0)).toBeNull();
});

test("mailbox objects are bound to topic, direction, fid and time", () => {
  const k = randomBytes(32);
  const fid = randomBytes(16);
  const obj = sealMailbox(k, 2, "nl-t", "c2p", fid, 10_000, { t: "text", text: "hi" });
  const key = (ep: number) => (ep === 2 ? k : null);
  expect(openMailbox(key, "nl-t", "c2p", fid, obj, 10_000)).toEqual({ t: "text", text: "hi" });
  expect(openMailbox(key, "nl-t", "p2c", fid, obj, 10_000)).toBeNull();
  expect(openMailbox(key, "nl-u", "c2p", fid, obj, 10_000)).toBeNull();
  expect(openMailbox(key, "nl-t", "c2p", randomBytes(16), obj, 10_000)).toBeNull();
  expect(openMailbox(key, "nl-t", "c2p", fid, obj, 10_000 + MAILBOX_MAX_AGE + 1)).toBeNull();
  expect(openMailbox(key, "nl-t", "c2p", fid, obj, 10_000 - 301)).toBeNull();
  expect(openMailbox(() => null, "nl-t", "c2p", fid, obj, 10_000)).toBeNull();
});

test("upload and receive stream chunk by chunk and verify the hash", async () => {
  const blobs = new MemBlobs();
  const files = new InlineCrypto();
  const data = randomBytes(CHUNK + 1234);
  const plan = newPlan("photo.jpg", data.length, "image/jpeg", await files.hash(new Blob([data])))!;
  expect(hex(plan.sha256)).toBe(hex(sha(data)));
  const seen: number[] = [];
  await uploadFile(blobs, files, "nl-t", new Blob([data]), plan, (d) => seen.push(d));
  expect(seen).toEqual([CHUNK, data.length]);
  const opened = [0, 1].map((i) => openChunk(plan, "p2c", i, blobs.objects.get(blobPath("nl-t", "p2c", plan.fidHex, i))!)!);
  expect(hex(new Uint8Array([...opened[0], ...opened[1]]))).toBe(hex(data));

  const incoming = pcUpload(blobs, "nl-t", "r.pdf", data);
  await receiveFile(blobs, files, "nl-t", incoming, () => {});
  expect(hex(files.files.get(incoming.fidHex)!)).toBe(hex(data));
  const bad = { ...pcUpload(blobs, "nl-t", "s.pdf", data), sha256: new Uint8Array(32) };
  await expect(receiveFile(blobs, files, "nl-t", bad, () => {})).rejects.toThrow("corrupt");
  expect(files.files.has(bad.fidHex)).toBe(false);
}, 30_000);

test("a file to the PC over a live session: offer, accept, upload, done, saved", async () => {
  const { link, pc, blobs } = await paired();
  const data = utf8("photo from the phone");
  pc.onMsg = (m) => {
    if (m.t === "offer") pc.seal({ t: "accept", fid: m.fid });
    if (m.t === "done") {
      const offer = pc.inbox.find((x) => x.t === "offer");
      const plan = planOf(offer)!;
      const got = openChunk(plan, "p2c", 0, blobs.objects.get(blobPath(pc.topic, "p2c", m.fid, 0))!)!;
      expect(hex(sha(got))).toBe(offer.sha256);
      pc.seal({ t: "saved", fid: m.fid });
    }
  };
  const r = await link.sendFile(new File([data], "IMG_1.jpg", { type: "image/jpeg" }));
  expect(r.ok).toBe(true);
  const x = link.snapshot().transfers[0];
  expect([x.state, x.dir, x.name, x.done]).toEqual(["saved", "p2c", "IMG_1.jpg", data.length]);
  link.stop();
});

test("the PC's reject and silence end a phone transfer with a reason", async () => {
  const { link, pc } = await paired();
  pc.onMsg = (m) => m.t === "offer" && pc.seal({ t: "reject", fid: m.fid, e: "tooBig" });
  expect(await link.sendFile(new File(["x"], "a.txt"))).toEqual({ ok: false, e: "tooBig" });
  pc.onMsg = null;
  expect(await link.sendFile(new File(["x"], "b.txt"))).toEqual({ ok: false, e: "timeout" });
  expect(link.snapshot().transfers.map((t) => t.state)).toEqual(["failed", "failed"]);
  link.stop();
});

test("a file from the PC: accept, download into the shelf, saved, objects released", async () => {
  const { link, pc, blobs, files, store } = await paired();
  const data = randomBytes(5000);
  const plan = pcUpload(blobs, pc.topic, "report.pdf", data);
  pc.seal(offerOf(plan));
  await until(() => pc.inbox.some((m) => m.t === "accept" && m.fid === plan.fidHex));
  pc.seal({ t: "done", fid: plan.fidHex });
  await until(() => pc.inbox.some((m) => m.t === "saved"));
  await until(() => blobs.objects.size === 0);
  expect(hex(files.files.get(plan.fidHex)!)).toBe(hex(data));
  expect(link.snapshot().files[0]).toMatchObject({ fid: plan.fidHex, name: "report.pdf", size: 5000, mime: "application/pdf" });
  expect(store.files.length).toBe(1);
  expect(blobs.released).toContain(`c2p/${plan.fidHex}/blob`);
  const got = await link.getFile(plan.fidHex);
  expect(got!.name).toBe("report.pdf");
  await link.removeFile(plan.fidHex);
  expect(files.files.size + store.files.length).toBe(0);
  link.stop();
});

test("an offer is refused when this phone may not receive files", async () => {
  const { link, pc, blobs } = await paired({ ...ALL, filesOut: false });
  const plan = pcUpload(blobs, pc.topic, "x.pdf", utf8("x"));
  pc.seal(offerOf(plan));
  await until(() => pc.inbox.some((m) => m.t === "reject"));
  expect(pc.inbox.find((m) => m.t === "reject")).toEqual({ t: "reject", fid: plan.fidHex, e: "denied" });
  link.stop();
});

test("with the PC offline, text and files go to its mailbox", async () => {
  const { link, pc, blobs } = await paired();
  pc.silent = true;
  link.reconnect();
  await until(() => link.snapshot().conn === "waiting");
  expect(await link.sendText("for later")).toEqual({ ok: true, d: { queued: true } });
  const r = await link.sendFile(new File([utf8("scan")], "scan.pdf", { type: "application/pdf" }));
  expect(r).toMatchObject({ ok: true, d: { queued: true } });
  const mbox = [...blobs.objects.keys()].filter((k) => k.includes("/mbox/p2c/"));
  expect(mbox.length).toBe(2);
  const now = Math.floor(Date.now() / 1000);
  const inners = mbox.map((k) => openMailbox((ep) => (ep === pc.ep ? pc.kDev : null), pc.topic, "p2c", Uint8Array.from(Buffer.from(k.split("/").pop()!, "hex")), blobs.objects.get(k)!, now));
  expect(inners.find((i) => i?.t === "text")).toEqual({ t: "text", text: "for later" });
  const offer = inners.find((i) => i?.t === "offer")!;
  const plan = planOf(offer)!;
  expect(new TextDecoder().decode(openChunk(plan, "p2c", 0, blobs.objects.get(blobPath(pc.topic, "p2c", plan.fidHex, 0))!)!)).toBe("scan");
  expect(link.snapshot().transfers[0].state).toBe("queued");
  link.stop();
});

test("the PC's mailbox is read on connect, once per item", async () => {
  const { link, pc, blobs, store, files } = await paired();
  link.stop();
  const now = Math.floor(Date.now() / 1000);
  const tfid = randomBytes(16);
  const textObj = sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", tfid, now, { t: "text", text: "while you were away" });
  blobs.objects.set(mboxPath(pc.topic, "c2p", hex(tfid)), textObj);
  const plan = pcUpload(blobs, pc.topic, "ticket.pdf", utf8("pdf bytes"));
  blobs.objects.set(mboxPath(pc.topic, "c2p", plan.fidHex), sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", plan.fid, now, offerOf(plan)));
  const stale = randomBytes(16);
  blobs.objects.set(mboxPath(pc.topic, "c2p", hex(stale)), sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", stale, now - MAILBOX_MAX_AGE - 10, { t: "text", text: "old" }));
  await link.start();
  await until(() => link.snapshot().files.length === 1 && link.snapshot().inbox.length === 1);
  await until(() => blobs.objects.size === 0);
  expect(link.snapshot().inbox[0].text).toBe("while you were away");
  expect(new TextDecoder().decode(files.files.get(plan.fidHex)!)).toBe("pdf bytes");
  expect(Object.keys(store.processed).sort()).toEqual([hex(tfid), plan.fidHex, hex(stale)].sort());
  expect(blobs.released).toEqual(expect.arrayContaining([`c2p/${plan.fidHex}/blob`, `c2p/${plan.fidHex}/mailbox`]));
  // A replayed object is not delivered again, after a restart too.
  link.stop();
  blobs.objects.set(mboxPath(pc.topic, "c2p", hex(tfid)), textObj);
  await link.start();
  await until(() => link.snapshot().conn === "online");
  await until(() => blobs.objects.size === 0, 500);
  expect(link.snapshot().inbox.length).toBe(1);
  link.stop();
});

test("a ratcheted phone still opens a mailbox item sealed under the previous key", async () => {
  const { link, pc, blobs, store } = await paired();
  const k0 = pc.kDev!;
  pc.proposeRekey();
  await until(() => store.device!.ep === 1);
  expect(store.device!.kPrev).toBeDefined();
  link.stop();
  const fid = randomBytes(16);
  blobs.objects.set(mboxPath(pc.topic, "c2p", hex(fid)), sealMailbox(k0, 0, pc.topic, "c2p", fid, Math.floor(Date.now() / 1000), { t: "text", text: "old key" }));
  await link.start();
  await until(() => link.snapshot().inbox.length === 1);
  link.stop();
});

test("relay blobs: upload URLs, a signed PUT without the user token, reads and deletes with it", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    if (url.endsWith("/functions/v1/link-upload")) return new Response(JSON.stringify({ uploads: [{ path: "nl-t/blob/p2c/ab/0", token: "tok.en-1", url: "http://kong/x" }] }));
    if (init?.method === "GET") return new Response(new Uint8Array([1, 2, 3]));
    if (url.includes("/object/list/")) return new Response(JSON.stringify([{ name: "aa", id: "1" }, { name: "dir", id: null }]));
    return new Response("{}");
  };
  const b = new RelayBlobs(CFG, () => "jwt", fetchFn);
  const [url] = await b.authorize("nl-t", "p2c", "ab", 1, "blob");
  expect(url).toBe(`${CFG.url}/storage/v1/object/upload/sign/link-blobs/nl-t/blob/p2c/ab/0?token=tok.en-1`);
  await b.put(url, new Uint8Array([9]));
  const put = calls.at(-1)!;
  expect(put.init.method).toBe("PUT");
  expect((put.init.headers as Record<string, string>).authorization).toBeUndefined();
  expect(Array.from(await b.get("nl-t/blob/p2c/ab/0"))).toEqual([1, 2, 3]);
  expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe("Bearer jwt");
  expect(await b.list("nl-t/mbox/c2p")).toEqual(["aa"]);
  expect(signedUploadUrl(CFG, "../x", "t")).toBeNull();
  expect(signedUploadUrl(CFG, "a/b", "t?x=1")).toBeNull();
  const denied = new RelayBlobs(CFG, () => "jwt", async () => new Response("no", { status: 403 }));
  await expect(denied.get("x")).rejects.toThrow("denied");
  const full = new RelayBlobs(CFG, () => "jwt", async () => new Response("q", { status: 429 }));
  await expect(full.authorize("nl-t", "p2c", "ab", 1, "blob")).rejects.toThrow("busy");
});

test("edge cases: names, chunk limits and mailbox window edges", () => {
  expect(sanitizeName("dir/")).toBe("file");
  expect(sanitizeName("<>:\"|?*")).toBe("file");
  expect(sanitizeName("C:\\Users\\x\\y.txt")).toBe("y.txt");
  expect(sanitizeName("a\u200Bb\uFEFF.txt")).toBe("ab.txt");
  const long = sanitizeName("n".repeat(200) + "." + "e".repeat(40));
  expect(Array.from(long).length).toBeLessThanOrEqual(120);
  expect(chunkCount(0)).toBe(1);
  expect(chunkCount(64 * CHUNK)).toBe(64);
  expect(chunkCount(64 * CHUNK + 1)).toBeNull();
  expect(chunkCount(-1)).toBeNull();
  expect(chunkCount(Number.NaN)).toBeNull();
  expect(newPlan("a", 64 * CHUNK + 1, "a/b", new Uint8Array(32))).toBeNull();
  expect(newPlan("a", 0, "", new Uint8Array(32))!.mime).toBe("application/octet-stream");
  const k = randomBytes(32);
  const fid = randomBytes(16);
  const obj = sealMailbox(k, 0, "nl-0123456789abcdef0123456789abcdef", "p2c", fid, 50_000, { t: "text", text: "x" });
  const keyFor = () => k;
  const topic = "nl-0123456789abcdef0123456789abcdef";
  expect(openMailbox(keyFor, topic, "p2c", fid, obj, 50_000 + MAILBOX_MAX_AGE)).not.toBeNull();
  expect(openMailbox(keyFor, topic, "p2c", fid, obj, 50_000 + MAILBOX_MAX_AGE + 1)).toBeNull();
  expect(openMailbox(keyFor, topic, "p2c", fid, obj, 50_000 - 300)).not.toBeNull();
  expect(openMailbox(keyFor, topic, "p2c", fid, obj, 50_000 - 301)).toBeNull();
  expect(openMailbox(keyFor, topic, "p2c", fid, utf8('{"ep":0,"created":50000,"c":"AA","x":1}'), 50_000)).toBeNull();
});

test("a failed upload after the PC's accept tells the PC and deletes its chunks", async () => {
  const { link, pc, blobs } = await paired();
  pc.onMsg = (m) => m.t === "offer" && pc.seal({ t: "accept", fid: m.fid });
  const put = blobs.put.bind(blobs);
  let n = 0;
  blobs.put = async (url: string, body: Uint8Array) => {
    if (++n >= 2) throw new BlobError("io");
    return put(url, body);
  };
  const r = await link.sendFile(new File([randomBytes(CHUNK + 10)], "v.mp4"));
  expect(r).toEqual({ ok: false, e: "io" });
  const fid = pc.inbox.find((m) => m.t === "offer")!.fid;
  await until(() => pc.inbox.some((m) => m.t === "reject"));
  expect(pc.inbox.find((m) => m.t === "reject")).toEqual({ t: "reject", fid, e: "io" });
  await until(() => ![...blobs.objects.keys()].some((k) => k.includes("/p2c/")));
  // Silence after an offer the PC may have accepted: it hears about the timeout too.
  pc.onMsg = null;
  blobs.put = put;
  expect(await link.sendFile(new File(["x"], "b.txt"))).toEqual({ ok: false, e: "timeout" });
  await until(() => pc.inbox.filter((m) => m.t === "reject").length === 2);
  link.stop();
});

test("a full phone leaves a mailbox offer for later and reads it when a transfer ends", async () => {
  const { link, pc, blobs, files } = await paired();
  const live = [1, 2, 3, 4].map((i) => pcUpload(blobs, pc.topic, `live${i}.pdf`, utf8(`live ${i}`)));
  for (const plan of live) pc.seal(offerOf(plan));
  await until(() => pc.inbox.filter((m) => m.t === "accept").length === 4);
  const late = pcUpload(blobs, pc.topic, "late.pdf", utf8("late"));
  const box = mboxPath(pc.topic, "c2p", late.fidHex);
  blobs.objects.set(box, sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", late.fid, Math.floor(Date.now() / 1000), offerOf(late)));
  // The scan a new session or a restart would run.
  const l = link as unknown as { scanMailbox(g: number): Promise<void>; gen: number };
  await l.scanMailbox(l.gen);
  expect(blobs.objects.has(box)).toBe(true);
  expect(blobs.objects.has(blobPath(pc.topic, "c2p", late.fidHex, 0))).toBe(true);
  pc.seal({ t: "done", fid: live[0].fidHex });
  await until(() => files.files.has(late.fidHex));
  await until(() => !blobs.objects.has(box));
  expect(new TextDecoder().decode(files.files.get(late.fidHex)!)).toBe("late");
  link.stop();
});

test("live offers still waiting for done are dropped when the session ends", async () => {
  const { link, pc, blobs } = await paired();
  const live = [1, 2, 3, 4].map((i) => pcUpload(blobs, pc.topic, `live${i}.pdf`, utf8(`live ${i}`)));
  for (const plan of live) pc.seal(offerOf(plan));
  await until(() => pc.inbox.filter((m) => m.t === "accept").length === 4);
  link.reconnect();
  await until(() => link.snapshot().conn === "online");
  await until(() => link.snapshot().transfers.filter((t) => t.state === "failed" && t.e === "offline").length === 4);
  const next = pcUpload(blobs, pc.topic, "next.pdf", utf8("next"));
  pc.seal(offerOf(next));
  await until(() => pc.inbox.some((m) => m.t === "accept" && m.fid === next.fidHex));
  link.stop();
});

test("a PC offer survives a phone session restart: offered again, then done downloads it", async () => {
  const { link, pc, blobs, files } = await paired();
  const plan = pcUpload(blobs, pc.topic, "big.pdf", utf8("big file"));
  pc.seal(offerOf(plan));
  await until(() => pc.inbox.some((m) => m.t === "accept" && m.fid === plan.fidHex));
  // The phone comes back after a long switch: its session restarts mid-upload.
  link.reconnect();
  await until(() => link.snapshot().conn === "online");
  await until(() => link.snapshot().transfers.some((t) => t.id === plan.fidHex && t.state === "failed"));
  // The PC offers its open file again on the new session, then sends done.
  pc.seal(offerOf(plan));
  await until(() => pc.inbox.filter((m) => m.t === "accept" && m.fid === plan.fidHex).length === 2);
  pc.seal({ t: "done", fid: plan.fidHex });
  await until(() => files.files.has(plan.fidHex));
  await until(() => pc.inbox.some((m) => m.t === "saved" && m.fid === plan.fidHex));
  // Offer and done again (another session): the phone already has it and says so.
  pc.seal(offerOf(plan));
  pc.seal({ t: "done", fid: plan.fidHex });
  await until(() => pc.inbox.filter((m) => m.t === "saved" && m.fid === plan.fidHex).length === 3);
  expect(pc.inbox.filter((m) => m.t === "accept" && m.fid === plan.fidHex).length).toBe(2);
  // A done for an offer the phone never held: reject expired, so the PC frees it at once.
  const stray = hex(randomBytes(16));
  pc.seal({ t: "done", fid: stray });
  await until(() => pc.inbox.some((m) => m.t === "reject" && m.fid === stray));
  expect(pc.inbox.find((m) => m.t === "reject" && m.fid === stray)).toEqual({ t: "reject", fid: stray, e: "expired" });
  link.stop();
});

test("a reject that found no session is sent after the next hs2", async () => {
  const { link, pc, blobs } = await paired();
  pc.onMsg = (m) => m.t === "offer" && pc.seal({ t: "accept", fid: m.fid });
  const put = blobs.put.bind(blobs);
  blobs.put = async () => {
    // The connection drops during the upload.
    (link as unknown as { endSession(): void }).endSession();
    throw new BlobError("network");
  };
  expect(await link.sendFile(new File(["abc"], "a.txt"))).toEqual({ ok: false, e: "network" });
  const fid = pc.inbox.find((m) => m.t === "offer")!.fid;
  expect(pc.inbox.some((m) => m.t === "reject")).toBe(false);
  blobs.put = put;
  link.reconnect();
  await until(() => pc.inbox.some((m) => m.t === "reject" && m.fid === fid));
  expect(pc.inbox.find((m) => m.t === "reject")).toEqual({ t: "reject", fid, e: "network" });
  link.stop();
});
