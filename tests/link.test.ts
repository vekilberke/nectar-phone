import { expect, test } from "bun:test";
import { b64u, unb64u } from "../src/core/bytes";
import * as c from "../src/core/crypto";
import { Link } from "../src/core/link";
import { parseQr } from "../src/core/protocol";
import { type Rest, RelayError } from "../src/core/relay";
import { Bus, CFG, FakeChannel, FakePc, FakeRest, MemoryStore, tick, until } from "./fakes";

const FAST = { hs2Ms: 60, resMs: 80, pingMs: 10_000, helloEveryMs: 30, retryMinMs: 20, retryMaxMs: 40 };

function setup(store = new MemoryStore()) {
  const bus = new Bus();
  const pc = new FakePc(bus);
  const rest = new FakeRest();
  const link = new Link({
    store,
    rest: rest as unknown as Rest,
    channel: () => new FakeChannel(bus),
    identity: () => ({ name: "Galaxy S26", ua: "Android Chrome" }),
    timing: FAST,
  });
  return { bus, pc, rest, link, store };
}

async function paired() {
  const t = setup();
  const now = Math.floor(Date.now() / 1000);
  const qr = parseQr(t.pc.qrHash(now + 300), CFG.ref, now);
  if (typeof qr === "string") throw new Error(qr);
  void t.link.pair(qr);
  await until(() => t.link.snapshot().pairing?.step === "code" && t.pc.code !== "");
  expect(t.link.snapshot().pairing!.code).toBe(t.pc.code);
  t.pc.welcome();
  await until(() => t.link.snapshot().conn === "online");
  return t;
}

test("pairing shows the PC's code, stores the device and goes online", async () => {
  const { link, store, pc } = await paired();
  expect(store.device!.topic).toBe(pc.topic);
  expect(store.device!.ep).toBe(0);
  expect(store.device!.kDev).toBe(b64u(pc.kDev!));
  expect(link.snapshot().device!.pcName).toBe("TEST-PC");
  link.stop();
});

test("commands get replies; status and text from the PC reach the snapshot", async () => {
  const { link, pc } = await paired();
  expect(await link.command("media.play_pause")).toEqual({ ok: true, d: null });
  expect(pc.inbox.at(-1)).toEqual({ t: "cmd", id: 1, op: "media.play_pause" });
  await link.command("volume.set", { v: 0.5 });
  expect(pc.inbox.at(-1).a).toEqual({ v: 0.5 });
  pc.seal({ t: "evt", op: "status", d: { locked: false, volume: { level: 0.3, muted: false }, media: null, battery: null, agent: null, asks: [{ id: 7, key: "07", name: "Claude Code", project: "nectar", tool: "Bash", detail: "ls" }] } });
  pc.seal({ t: "text", text: "from pc" });
  await until(() => link.snapshot().inbox.length === 1);
  expect(link.snapshot().status!.asks![0].id).toBe(7);
  expect(link.snapshot().inbox[0].text).toBe("from pc");
  expect(await link.sendText("hi")).toEqual({ ok: true, d: null });
  link.stop();
});

test("rekey on the current session is stored before rekeyed, and the next hs1 uses it", async () => {
  const { link, pc, store, bus } = await paired();
  const before = store.device!.kDev;
  pc.proposeRekey();
  await until(() => pc.ep === 1);
  expect(store.device!.ep).toBe(1);
  expect(store.device!.kDev).not.toBe(before);
  expect(store.device!.kDev).toBe(b64u(pc.kDev!));
  // The PC forgets the session; the phone's command times out and it handshakes again under ep 1.
  pc.autoRes = false;
  const hs1Count = pc.hs1s.length;
  expect((await link.command("media.next")).ok).toBe(false);
  await until(() => pc.hs1s.length > hs1Count && link.snapshot().conn === "online");
  expect(pc.hs1s.at(-1).ep).toBe(1);
  expect(bus.sent.filter((s) => s.event === "hs1").length).toBeGreaterThan(1);
  link.stop();
});

test("a late rekey from an old session is never applied (appendix B ratchet rule)", async () => {
  const { link, pc, store } = await paired();
  const old = { sid: pc.sid!, keys: pc.keys!, n: 50 };
  // New session S2 starts (the phone's command timed out on S1).
  pc.autoRes = false;
  await link.command("media.next");
  await until(() => link.snapshot().conn === "online" && pc.sid !== old.sid);
  pc.autoRes = true;
  pc.seal({ t: "rekey", ep: 1 }, old);
  await tick(30);
  expect(store.device!.ep).toBe(0);
  expect(store.device!.kDev).toBe(b64u(pc.kDev!));
  expect(pc.inbox.some((m) => m.t === "rekeyed")).toBe(false);
  link.stop();
});

test("replayed and tampered PC messages are dropped", async () => {
  const { link, pc } = await paired();
  pc.seal({ t: "text", text: "one" });
  await until(() => link.snapshot().inbox.length === 1);
  const n = pc.sendN;
  pc.seal({ t: "text", text: "replay" }, { sid: pc.sid!, keys: pc.keys!, n });
  const bogus = { ...pc.keys!, c2p: new Uint8Array(32) };
  pc.seal({ t: "text", text: "forged" }, { sid: pc.sid!, keys: bogus, n: n + 5 });
  await tick(20);
  expect(link.snapshot().inbox.map((i) => i.text)).toEqual(["one"]);
  link.stop();
});

test("bye from the PC ends the session until the phone reconnects", async () => {
  const { link, pc } = await paired();
  pc.seal({ t: "bye" });
  await until(() => link.snapshot().conn === "ended");
  expect((await link.command("media.next")).ok).toBe(false);
  link.reconnect();
  await until(() => link.snapshot().conn === "online");
  link.stop();
});

test("relink from a PC back on the relay starts a new session at once", async () => {
  const { link, pc } = await paired();
  const n = pc.hs1s.length;
  pc.seal({ t: "relink" });
  await until(() => pc.hs1s.length > n && link.snapshot().conn === "online");
  expect((await link.command("media.next")).ok).toBe(true);
  link.stop();
});

test("a silent PC shows waiting and the hs1 is retried", async () => {
  const { link, pc } = await paired();
  pc.silent = true;
  pc.autoRes = false;
  const n = pc.hs1s.length;
  await link.command("status.get");
  await until(() => link.snapshot().conn === "waiting");
  pc.silent = false;
  await until(() => link.snapshot().conn === "online", 3000);
  expect(pc.hs1s.length).toBeGreaterThan(n);
  link.stop();
});

test("lost membership: rejoin with K_rejoin, or revoked when the topic is gone", async () => {
  const first = await paired();
  first.link.stop();
  const store = first.store;
  const t = setup(store);
  t.pc.kDev = first.pc.kDev;
  t.pc.topic = first.pc.topic;
  t.bus.unauthorized.add(first.pc.topic);
  await t.link.start();
  await until(() => t.link.snapshot().conn === "online");
  const call = t.rest.calls.find((x) => x.name === "link_rejoin")!;
  expect(call.args.t).toBe(first.pc.topic);
  const mac = c.rejoinMac(unb64u(store.device!.kRejoin)!, first.pc.topic, store.auth!.userId, call.args.ts as number);
  expect(call.args.mac).toBe("\\x" + Buffer.from(mac).toString("hex"));
  t.link.stop();

  const r = setup(store);
  r.bus.unauthorized.add(first.pc.topic);
  r.rest.rejoinError = "bad mac";
  await r.link.start();
  await until(() => r.link.snapshot().conn === "revoked");
  r.link.stop();
});

test("pairing fails as expired when the offer is gone", async () => {
  const t = setup();
  const now = Math.floor(Date.now() / 1000);
  const qr = parseQr(t.pc.qrHash(now + 300), CFG.ref, now);
  if (typeof qr === "string") throw new Error(qr);
  t.bus.unauthorized.add(c.pairTopic(t.pc.ps));
  await t.link.pair(qr);
  expect(t.link.snapshot().pairing).toMatchObject({ step: "error", error: "expired" });
});

test("forget sends unpair and wipes the device", async () => {
  const { link, pc, store } = await paired();
  await link.forget();
  expect(pc.inbox.at(-1)).toEqual({ t: "unpair" });
  expect(store.device).toBeNull();
  expect(link.snapshot().device).toBeNull();
});

test("taking the session lock back reloads the key another tab ratcheted (no clone suspension)", async () => {
  const a = await paired();
  await a.link.start(); // as on page load
  await until(() => a.link.snapshot().conn === "online");
  a.link.stop(); // tab A loses the lock
  const b = new Link({ store: a.store, rest: a.rest as unknown as Rest, channel: () => new FakeChannel(a.bus), identity: () => ({ name: "Galaxy S26", ua: "Android Chrome" }), timing: FAST });
  await b.start();
  await until(() => b.snapshot().conn === "online");
  a.pc.proposeRekey();
  await until(() => a.pc.ep === 1 && a.store.device!.ep === 1);
  b.stop(); // tab A steals the lock back
  const before = a.pc.hs1s.length;
  await a.link.start();
  await until(() => a.link.snapshot().conn === "online");
  expect(a.pc.hs1s.length).toBeGreaterThan(before);
  expect(a.pc.hs1s.slice(before).every((h) => h.ep === 1)).toBe(true);
  a.link.stop();
});

test("a perms event right after a rekey cannot write the old key back", async () => {
  class SlowStore extends MemoryStore {
    override async saveDevice(d: Parameters<MemoryStore["saveDevice"]>[0]) {
      await tick(15);
      await super.saveDevice(d);
    }
  }
  const store = new SlowStore();
  const t = setup(store);
  const now = Math.floor(Date.now() / 1000);
  const qr = parseQr(t.pc.qrHash(now + 300), CFG.ref, now);
  if (typeof qr === "string") throw new Error(qr);
  void t.link.pair(qr);
  await until(() => t.pc.code !== "" && t.link.snapshot().pairing?.step === "code");
  t.pc.welcome();
  await until(() => t.link.snapshot().conn === "online");
  t.pc.proposeRekey();
  t.pc.seal({ t: "evt", op: "perms", d: { media: true, status: false } });
  await until(() => t.pc.ep === 1);
  await tick(60);
  expect(store.device!.ep).toBe(1);
  expect(store.device!.kDev).toBe(b64u(t.pc.kDev!));
  expect(store.device!.perms).toEqual({ media: true, status: false });
  t.link.stop();
});

test("a refresh failing with 5xx is retried; only a dead refresh token starts a new user", async () => {
  const first = await paired();
  first.link.stop();
  const store = first.store;
  store.auth = { ...store.auth!, expiresAt: Math.floor(Date.now() / 1000) - 10 };

  const down = setup(store);
  down.rest.refresh = async () => {
    throw new RelayError("status", 502, "Bad Gateway");
  };
  await down.link.start();
  await until(() => down.link.snapshot().conn === "offline");
  expect(down.rest.signups).toBe(0);
  down.link.stop();

  const dead = setup(store);
  dead.rest.refresh = async () => {
    throw new RelayError("status", 400, "Invalid Refresh Token: Already Used");
  };
  await dead.link.start();
  await until(() => dead.rest.signups === 1);
  dead.link.stop();
});

test("text and commands over the PC's size limit are refused without sending", async () => {
  const { link, pc } = await paired();
  const n = pc.inbox.length;
  // 40 000 two-byte characters: under 64 Ki UTF-16 units, over 64 KiB of UTF-8.
  expect(await link.sendText("ş".repeat(40_000))).toEqual({ ok: false, e: "tooLong" });
  expect(await link.command("clipboard.set", { text: "a".repeat(70_000) })).toEqual({ ok: false, e: "tooLong" });
  expect(pc.inbox.length).toBe(n);
  expect(link.snapshot().conn).toBe("online");
  link.stop();
});

test("asks from an ended session are cleared and stay empty until the new session's status", async () => {
  const { link, pc } = await paired();
  const status = (asks: unknown[]) => ({ locked: false, volume: null, media: null, battery: null, agent: null, asks });
  pc.seal({ t: "evt", op: "status", d: status([{ id: 1, key: "aa", tool: "Bash", full: "git status" }]) });
  await until(() => (link.snapshot().status?.asks?.length ?? 0) === 1);
  // Nectar restarts: the session ends and the next ask reuses nothing from before.
  pc.seal({ t: "bye" });
  await until(() => link.snapshot().conn === "ended");
  expect(link.snapshot().status!.asks).toEqual([]);
  link.reconnect();
  await until(() => link.snapshot().conn === "online");
  expect(link.snapshot().status!.asks).toEqual([]);
  pc.seal({ t: "evt", op: "status", d: status([{ id: 1, key: "bb", tool: "PowerShell", full: "Remove-Item -Recurse $HOME" }]) });
  await until(() => link.snapshot().status?.asks?.[0]?.key === "bb");
  expect(link.snapshot().status!.asks![0].detail).toBe("Remove-Item -Recurse $HOME");
  link.stop();
});
