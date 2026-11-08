// PC clipboard to phone (T-016): the newest PC copy replaces the older one in the inbox; only a
// fresh live copy is written to the phone clipboard, once, as it reaches a visible page.
import { expect, test } from "bun:test";
import { hex, randomBytes } from "../src/core/bytes";
import { Link } from "../src/core/link";
import { parsePcMessage } from "../src/core/messages";
import { parseQr } from "../src/core/protocol";
import type { Rest } from "../src/core/relay";
import { mboxPath, sealMailbox } from "../src/core/transfer";
import { Bus, CFG, FakeChannel, FakePc, FakeRest, MemBlobs, MemoryStore, tick, until } from "./fakes";

const FAST = { hs2Ms: 60, resMs: 80, pingMs: 10_000, helloEveryMs: 30, retryMinMs: 20, retryMaxMs: 40 };

class FakeClipboard {
  allowed = true;
  written: string[] = [];
  async write(text: string) {
    if (!this.allowed) return false;
    this.written.push(text);
    return true;
  }
}

async function paired() {
  const bus = new Bus();
  const pc = new FakePc(bus);
  const blobs = new MemBlobs();
  const clipboard = new FakeClipboard();
  const clock = { offset: 0 };
  const link = new Link({
    store: new MemoryStore(),
    rest: new FakeRest() as unknown as Rest,
    channel: () => new FakeChannel(bus),
    identity: () => ({ name: "Galaxy S26", ua: "Android Chrome" }),
    timing: FAST,
    blobs: () => blobs,
    clipboard,
    now: () => Date.now() + clock.offset,
  });
  const now = Math.floor(Date.now() / 1000);
  const qr = parseQr(pc.qrHash(now + 300), CFG.ref, now);
  if (typeof qr === "string") throw new Error(qr);
  void link.pair(qr);
  await until(() => pc.code !== "");
  pc.welcome({ clipboardOut: true, textOut: true });
  await until(() => link.snapshot().conn === "online");
  return { link, pc, blobs, clipboard, clock };
}

const clips = (link: Link) => link.snapshot().inbox.filter((i) => i.clip);

test("clip messages are checked like other PC messages", () => {
  expect(parsePcMessage({ t: "clip", text: "a", at: 5 })).toEqual({ t: "clip", text: "a", at: 5 });
  expect(parsePcMessage({ t: "clip", text: "", at: 5 })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: "a" })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: "a", at: -1 })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: "a", at: 1.5 })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: "x".repeat(64 * 1024 + 1), at: 5 })).toBeNull();
});

test("a live PC copy goes to the phone clipboard and replaces the older one in the inbox", async () => {
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "text", text: "sent on purpose" });
  pc.seal({ t: "clip", text: "first copy", at: 100 });
  await until(() => clips(link).length === 1 && clips(link)[0].copied === true);
  expect(clipboard.written).toEqual(["first copy"]);
  pc.seal({ t: "clip", text: "second copy", at: 101 });
  await until(() => clips(link)[0]?.text === "second copy" && clips(link)[0].copied === true);
  expect(clips(link).length).toBe(1);
  expect(clipboard.written).toEqual(["first copy", "second copy"]);
  expect(link.snapshot().inbox.map((i) => i.text)).toEqual(["second copy", "sent on purpose"]);
  link.stop();
});

test("an older PC copy never replaces a newer one", async () => {
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "clip", text: "new", at: 200 });
  await until(() => clips(link)[0]?.copied === true);
  pc.seal({ t: "clip", text: "old", at: 199 });
  pc.seal({ t: "text", text: "marker" });
  await until(() => link.snapshot().inbox.some((i) => i.text === "marker"));
  expect(clips(link).map((i) => i.text)).toEqual(["new"]);
  expect(clipboard.written).toEqual(["new"]);
  link.stop();
});

// I-319: anything copied on the phone after the copy arrived would be overwritten by a later write.
test("a copy that could not be written when it came stays offered and is not written later", async () => {
  const { link, pc, clipboard } = await paired();
  clipboard.allowed = false;
  pc.seal({ t: "clip", text: "while not focused", at: 300 });
  await until(() => clips(link).length === 1);
  await tick(20);
  clipboard.allowed = true;
  link.setVisible(true);
  await tick(20);
  expect(clipboard.written).toEqual([]);
  expect(clips(link).map((i) => [i.text, i.copied])).toEqual([["while not focused", undefined]]);
  link.stop();
});

test("a copy that reaches a hidden page is only offered, also when the PC sends it again on return", async () => {
  // Hidden but alive, the page still gets live messages until the PC drops the session.
  const { link, pc, clipboard } = await paired();
  link.setVisible(false);
  pc.seal({ t: "clip", text: "X from the pc", at: 400 });
  await until(() => clips(link).length === 1);
  await tick(20);
  link.setVisible(true);
  // The phone never answered it, so the PC sends it again at the next session start.
  pc.seal({ t: "clip", text: "X from the pc", at: 400, late: true });
  pc.seal({ t: "text", text: "marker" });
  await until(() => link.snapshot().inbox.some((i) => i.text === "marker"));
  await tick(20);
  expect(clipboard.written).toEqual([]);
  expect(clips(link).map((i) => [i.text, i.copied])).toEqual([["X from the pc", undefined]]);
  link.stop();
});

test("a copy the PC sends late at a session start is offered, not written", async () => {
  // Made before this session: the phone clipboard may hold something newer by now.
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "clip", text: "made while away", at: 450, late: true });
  await until(() => clips(link).length === 1);
  await tick(20);
  expect(clipboard.written).toEqual([]);
  pc.seal({ t: "clip", text: "made now", at: 451 });
  await until(() => clips(link)[0]?.copied === true);
  expect(clipboard.written).toEqual(["made now"]);
  link.stop();
});

test("PC copies from the mailbox keep only the newest and are offered, not written", async () => {
  const { link, pc, blobs, clipboard } = await paired();
  link.stop();
  const now = Math.floor(Date.now() / 1000);
  const put = (text: string, at: number) => {
    const fid = randomBytes(16);
    blobs.objects.set(mboxPath(pc.topic, "c2p", hex(fid)), sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", fid, now, { t: "clip", text, at }));
  };
  put("older", now - 60);
  put("newer", now - 10);
  await link.start();
  await until(() => blobs.objects.size === 0);
  expect(clips(link).map((i) => i.text)).toEqual(["newer"]);
  link.setVisible(true);
  await tick(20);
  expect(clipboard.written).toEqual([]);
  link.stop();
});

test("two PC copies in the same second: the later one wins", async () => {
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "clip", text: "first", at: 500 });
  pc.seal({ t: "clip", text: "second", at: 500 });
  await until(() => clips(link)[0]?.text === "second" && clips(link)[0].copied === true);
  expect(clips(link).length).toBe(1);
  expect(clipboard.written.at(-1)).toBe("second");
  link.stop();
});

test("a clipboard writer that throws leaves the copy offered and does not break the next one", async () => {
  const { link, pc, clipboard } = await paired();
  const write = clipboard.write.bind(clipboard);
  let fail = true;
  clipboard.write = async (t: string) => {
    if (fail) throw new Error("NotAllowedError");
    return write(t);
  };
  pc.seal({ t: "clip", text: "refused", at: 600 });
  await until(() => clips(link).length === 1);
  await tick(20);
  expect(clips(link)[0].copied).toBeUndefined();
  fail = false;
  pc.seal({ t: "clip", text: "next", at: 601 });
  await until(() => clips(link)[0]?.copied === true);
  expect(clipboard.written).toEqual(["next"]);
  link.stop();
});

test("a slow write of an older copy does not mark the newer copy as written", async () => {
  const { link, pc, clipboard } = await paired();
  const write = clipboard.write.bind(clipboard);
  const gates: Record<string, () => void> = {};
  clipboard.write = async (t: string) => {
    await new Promise<void>((r) => (gates[t] = r));
    return write(t);
  };
  pc.seal({ t: "clip", text: "A", at: 700 });
  await until(() => "A" in gates);
  pc.seal({ t: "clip", text: "B", at: 701 });
  await until(() => clips(link)[0]?.text === "B");
  await tick(20);
  expect("B" in gates).toBe(false);
  gates.A();
  await until(() => "B" in gates);
  expect(clips(link).map((i) => [i.text, i.copied])).toEqual([["B", undefined]]);
  gates.B();
  await until(() => clips(link)[0]?.copied === true);
  expect(clips(link).map((i) => i.text)).toEqual(["B"]);
  expect(clipboard.written).toEqual(["A", "B"]);
  link.stop();
});

test("clipboard writes run one at a time, so the newest copy ends on the phone clipboard", async () => {
  const { link, pc, clipboard } = await paired();
  const write = clipboard.write.bind(clipboard);
  // The older write finishes last unless writes are queued.
  clipboard.write = async (t: string) => {
    await tick(t === "A" ? 60 : 0);
    return write(t);
  };
  pc.seal({ t: "clip", text: "A", at: 800 });
  await until(() => clips(link)[0]?.text === "A");
  pc.seal({ t: "clip", text: "B", at: 801 });
  await until(() => clips(link)[0]?.copied === true);
  await tick(80);
  expect(clipboard.written.at(-1)).toBe("B");
  expect(clips(link).map((i) => [i.text, i.copied])).toEqual([["B", true]]);
  link.stop();
});

test("the same copy from the mailbox and late over the session is shown once and offered", async () => {
  // The PC sends a copy whose upload ran while the phone connected over the new session too.
  const { link, pc, blobs, clipboard } = await paired();
  link.stop();
  const fid = randomBytes(16);
  const copy = { t: "clip", text: "both ways", at: 1_000 };
  blobs.objects.set(mboxPath(pc.topic, "c2p", hex(fid)), sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", fid, Math.floor(Date.now() / 1000), copy));
  await link.start();
  await until(() => blobs.objects.size === 0 && clips(link).length === 1 && link.snapshot().conn === "online");
  const id = clips(link)[0].id;
  pc.seal({ ...copy, late: true });
  pc.seal({ t: "text", text: "marker" });
  await until(() => link.snapshot().inbox.some((i) => i.text === "marker"));
  await tick(20);
  expect(clips(link).map((i) => [i.id, i.text, i.copied])).toEqual([[id, "both ways", undefined]]);
  expect(clipboard.written).toEqual([]);
  link.stop();
});

test("a copy already written is not written again when it comes once more", async () => {
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "clip", text: "once", at: 1_100 });
  await until(() => clips(link)[0]?.copied === true);
  pc.seal({ t: "clip", text: "once", at: 1_100 });
  pc.seal({ t: "text", text: "marker" });
  await until(() => link.snapshot().inbox.some((i) => i.text === "marker"));
  await tick(20);
  expect(clipboard.written).toEqual(["once"]);
  expect(clips(link).length).toBe(1);
  link.stop();
});

test("a mailbox copy older than a live one is dropped", async () => {
  const { link, pc, blobs, clipboard } = await paired();
  pc.seal({ t: "clip", text: "live", at: 900 });
  await until(() => clips(link)[0]?.copied === true);
  link.stop();
  const fid = randomBytes(16);
  blobs.objects.set(mboxPath(pc.topic, "c2p", hex(fid)), sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", fid, Math.floor(Date.now() / 1000), { t: "clip", text: "stale", at: 800 }));
  await link.start();
  await until(() => blobs.objects.size === 0);
  expect(clips(link).map((i) => i.text)).toEqual(["live"]);
  expect(clipboard.written).toEqual(["live"]);
  link.stop();
});

test("clip messages: edge values of at and text", () => {
  expect(parsePcMessage({ t: "clip", text: "a", at: 0 })).toEqual({ t: "clip", text: "a", at: 0 });
  expect(parsePcMessage({ t: "clip", text: "a", at: Number.MAX_SAFE_INTEGER })).not.toBeNull();
  expect(parsePcMessage({ t: "clip", text: "a", at: Number.MAX_SAFE_INTEGER + 2 })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: "a", at: Number.NaN })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: "a", at: "5" })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: 5, at: 5 })).toBeNull();
  expect(parsePcMessage({ t: "clip", text: "x".repeat(64 * 1024), at: 5 })).not.toBeNull();
  expect(parsePcMessage({ t: "clip", text: "a", at: 5, late: true })).toEqual({ t: "clip", text: "a", at: 5, late: true });
  expect(parsePcMessage({ t: "clip", text: "a", at: 5, late: "yes" })).toEqual({ t: "clip", text: "a", at: 5 });
});

test("an invalid clip over the live session is ignored and keeps the earlier copy", async () => {
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "clip", text: "good", at: 10 });
  await until(() => clips(link)[0]?.copied === true);
  pc.seal({ t: "clip", text: "", at: 20 });
  pc.seal({ t: "clip", text: "bad", at: -4 });
  await tick(40);
  expect(clips(link).map((i) => i.text)).toEqual(["good"]);
  expect(clipboard.written).toEqual(["good"]);
  link.stop();
});

test("ordinary text from the mailbox does not replace the clip item", async () => {
  const { link, pc, blobs } = await paired();
  pc.seal({ t: "clip", text: "clip", at: 10 });
  await until(() => clips(link).length === 1);
  link.stop();
  const fid = randomBytes(16);
  blobs.objects.set(mboxPath(pc.topic, "c2p", hex(fid)), sealMailbox(pc.kDev!, pc.ep, pc.topic, "c2p", fid, Math.floor(Date.now() / 1000), { t: "text", text: "plain" }));
  await link.start();
  await until(() => blobs.objects.size === 0);
  expect(link.snapshot().inbox.map((i) => i.text).sort()).toEqual(["clip", "plain"]);
  expect(clips(link).map((i) => i.text)).toEqual(["clip"]);
  link.stop();
});

// I-312: one copy stamped far ahead (PC clock wrong, then corrected) made the phone ignore every
// later copy until the PC was forgotten.
test("copies after a PC clock correction are not ignored", async () => {
  const { link, pc } = await paired();
  pc.seal({ t: "clip", text: "future", at: Date.now() + 86_400_000 });
  await until(() => clips(link).length === 1);
  pc.seal({ t: "clip", text: "now", at: Date.now() });
  await until(() => clips(link)[0]?.text === "now");
  link.stop();
});

test("a PC clock a little ahead still orders copies exactly", async () => {
  const { link, pc } = await paired();
  const at = Date.now() + 60_000;
  pc.seal({ t: "clip", text: "new", at });
  await until(() => clips(link)[0]?.copied === true);
  pc.seal({ t: "clip", text: "old", at: at - 1 });
  pc.seal({ t: "text", text: "marker" });
  await until(() => link.snapshot().inbox.some((i) => i.text === "marker"));
  expect(clips(link).map((i) => i.text)).toEqual(["new"]);
  link.stop();
});

test("leaving the page says bye, and the next visible starts a new session", async () => {
  // The PC then puts later copies in the mailbox instead of a session nobody listens on.
  const { link, pc } = await paired();
  const hs = pc.hs1s.length;
  link.leave();
  await until(() => pc.inbox.some((m) => m.t === "bye"));
  expect(link.snapshot().conn).toBe("ended");
  link.leave();
  await tick(20);
  expect(pc.inbox.filter((m) => m.t === "bye").length).toBe(1);
  link.setVisible(true);
  await until(() => link.snapshot().conn === "online" && pc.hs1s.length === hs + 1);
  link.stop();
});

test("leaving before the session is up sends nothing", async () => {
  const { link, pc } = await paired();
  pc.silent = true;
  link.reconnect();
  await until(() => link.snapshot().conn === "handshake" || link.snapshot().conn === "waiting");
  const before = pc.inbox.length;
  link.leave();
  await tick(20);
  expect(pc.inbox.length).toBe(before);
  link.stop();
});

// Tester round 3 (T-016), I-318.
test("a copy the user dismissed does not come back when the PC sends it again", async () => {
  // After a new session the PC may send the unanswered copy again (I-314); a dismissed item must stay gone.
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "clip", text: "gone", at: 1_000 });
  await until(() => clips(link)[0]?.copied === true);
  link.dismissInbox(clips(link)[0].id);
  expect(clips(link)).toEqual([]);
  pc.seal({ t: "clip", text: "gone", at: 1_000 });
  pc.seal({ t: "text", text: "marker" });
  await until(() => link.snapshot().inbox.some((i) => i.text === "marker"));
  expect(clips(link)).toEqual([]);
  expect(clipboard.written).toEqual(["gone"]);
  link.stop();
});

test("a copy with an older mailbox time but a newer at still wins over the earlier live copy", async () => {
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "clip", text: "first", at: 1_000 });
  pc.seal({ t: "clip", text: "second", at: 1_001 });
  await until(() => clips(link)[0]?.text === "second" && clips(link)[0]?.copied === true);
  expect(clips(link).length).toBe(1);
  expect(clipboard.written.at(-1)).toBe("second");
  link.stop();
});

test("a permission change on the PC reaches the open page without a reload (T-024)", async () => {
  const { link, pc, clipboard } = await paired();
  pc.seal({ t: "evt", op: "perms", d: { textOut: true, clipboardOut: false } });
  await until(() => link.snapshot().device?.perms.clipboardOut === false);
  pc.seal({ t: "evt", op: "perms", d: { textOut: true, clipboardOut: true } });
  await until(() => link.snapshot().device?.perms.clipboardOut === true);
  expect(link.snapshot().conn).toBe("online");
  pc.seal({ t: "clip", text: "after the grant", at: 300 });
  await until(() => clips(link)[0]?.copied === true);
  expect(clipboard.written).toEqual(["after the grant"]);
  link.stop();
});
