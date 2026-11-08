import { expect, test } from "bun:test";
import { b64u, utf8 } from "../src/core/bytes";
import { askCardId, normalizeUrl, opAllowed, parsePcMessage, parseStatus } from "../src/core/messages";
import { cleanText, parseQr } from "../src/core/protocol";
import { broadcastFrame, bytea, joinFrame, parseAuth, parseFrame } from "../src/core/relay";

const REF = "qziazuduzrdqnnwdlxqb";
const key = b64u(new Uint8Array(32).fill(1));
const qr = (o: object) => "#v1." + b64u(utf8(JSON.stringify(o)));

test("QR: accepts a valid offer, rejects other relays, expiry and junk", () => {
  const ok = parseQr(qr({ r: REF, s: key, p: key, n: "BERKE\u0007-PC", x: 1300 }), REF, 1000);
  expect(typeof ok).toBe("object");
  expect((ok as { pcName: string }).pcName).toBe("BERKE-PC");
  expect(parseQr(qr({ r: "other", s: key, p: key, n: "x", x: 1300 }), REF, 1000)).toBe("relay");
  expect(parseQr(qr({ r: REF, s: key, p: key, n: "x", x: 999 }), REF, 1000)).toBe("expired");
  expect(parseQr(qr({ r: REF, s: key, p: key, n: "x", x: 99999 }), REF, 1000)).toBe("expired");
  expect(parseQr(qr({ r: REF, s: "short", p: key, n: "x", x: 1300 }), REF, 1000)).toBe("format");
  expect(parseQr("#v1.%%%", REF, 1000)).toBe("format");
  expect(parseQr("", REF, 1000)).toBe("format");
  expect(parseQr("#v1." + b64u(utf8("[1]")), REF, 1000)).toBe("format");
});

test("PC messages are validated and status fields are bounded", () => {
  expect(parsePcMessage({ t: "res", id: 3, ok: false, e: "weird" })).toEqual({ t: "res", id: 3, ok: false, e: "failed" });
  expect(parsePcMessage({ t: "nope" })).toBeNull();
  expect(parsePcMessage({ t: "rekey", ep: 0 })).toBeNull();
  expect(parsePcMessage({ t: "text", text: "" })).toBeNull();
  const s = parseStatus({
    battery: { percent: 150, charging: true },
    volume: { level: 2, muted: true },
    media: { playing: true, title: "x".repeat(500) },
    agent: { state: "needs_input", name: "Claude Code", project: "nectar" },
    asks: [{ id: 1, key: "ab12", tool: "Bash", detail: "rm -rf /" }, { id: -1, key: "ab" }, { id: 2, tool: "Bash", full: "ls" }, { id: 3, key: "x y", full: "ls" }, "junk"],
    asksMore: 3,
    locked: true,
  })!;
  expect(s.battery!.percent).toBe(100);
  expect(s.volume!.level).toBe(1);
  expect(s.media!.title!.length).toBe(200);
  // Without a valid key an ask cannot be answered from the phone, so it is not shown.
  expect(s.asks!.map((a) => a.id)).toEqual([1]);
  expect(s.asksMore).toBe(3);
  // An old PC's one-line `detail` cannot be trusted to be the whole command.
  expect(s.asks![0].truncated).toBe(true);
  expect(parseStatus(null)).toBeNull();
  expect(s.maxInMb).toBeUndefined();
  expect(parseStatus({ locked: false, maxInMb: 150 })!.maxInMb).toBe(150);
  expect(parseStatus({ locked: false, maxInMb: 5000 })!.maxInMb).toBe(200);
});

test("URLs: only http(s), no credentials; bare hosts get https", () => {
  expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
  expect(normalizeUrl("http://x.org")).toBe("http://x.org/");
  expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeUrl("file:///c:/x")).toBeNull();
  expect(normalizeUrl("https://u:p@x.org")).toBeNull();
  expect(normalizeUrl("https://x.org/" + "a".repeat(3000))).toBeNull();
});

test("permissions gate ops like the PC does", () => {
  expect(opAllowed({}, "media.next")).toBe(false);
  expect(opAllowed({ openUrl: "ask" }, "url.open")).toBe(true);
  expect(opAllowed({ openUrl: "off" }, "url.open")).toBe(false);
  expect(opAllowed({ agentAsk: true }, "agent.answer")).toBe(true);
  expect(cleanText("a\u0000b  ", 10)).toBe("ab");
});

test("relay frames match the PC's Phoenix frames", () => {
  const j = joinFrame("nl-x", 4, "tok");
  expect(j).toEqual({
    topic: "realtime:nl-x",
    event: "phx_join",
    payload: { config: { broadcast: { self: false, ack: true }, presence: { key: "phone" }, private: true }, access_token: "tok" },
    ref: "4",
    join_ref: "4",
  });
  expect(broadcastFrame("nl-x", "m", { a: 1 }, 5, 4).payload).toEqual({ type: "broadcast", event: "m", payload: { a: 1 } });
  expect(parseFrame("{bad")).toBeNull();
  expect(bytea(Uint8Array.of(0, 255))).toBe("\\x00ff");
  expect(parseAuth({ access_token: "a", refresh_token: "r", expires_in: 60, user: { id: "00000000-0000-4000-8000-000000000001" } }, 100)!.expiresAt).toBe(160);
  expect(parseAuth({ access_token: "a", refresh_token: "r", user: { id: "nope" } }, 100)).toBeNull();
});

test("asks: every line of the command is kept and a cut command is marked", () => {
  const asks = (list: unknown[]) => parseStatus({ asks: list })!.asks!;
  const [whole] = asks([{ id: 1, key: "1", tool: "Bash", detail: "cd C:\proj", full: "cd C:\proj\r\nRemove-Item -Recurse $HOME\u202e\u0007", truncated: false }]);
  expect(whole.detail).toBe("cd C:\proj\nRemove-Item -Recurse $HOME");
  expect(whole.truncated).toBe(false);
  expect(asks([{ id: 2, key: "2", full: "x", truncated: true }])[0].truncated).toBe(true);
  const [long] = asks([{ id: 3, key: "3", full: "y".repeat(2500), truncated: false }]);
  expect(long.detail.length).toBe(2000);
  expect(long.truncated).toBe(true);
  expect(asks([{ id: 4, key: "4", tool: "Read" }])[0]).toMatchObject({ detail: "", truncated: false });
});

test("asks: a lone CR or a Unicode line separator is a new line, not glued text", () => {
  const [a] = parseStatus({ asks: [{ id: 5, key: "5", full: "Get-ChildItem .\\\rrm -r -fo $HOME\u2028x\u0085y" }] })!.asks!;
  expect(a.detail).toBe("Get-ChildItem .\\\nrm -r -fo $HOME\nx\ny");
});

test("an ask card is a new card when the same id comes back with another key or command", () => {
  const base = { id: 1, key: "aa", name: "", project: "", tool: "Bash", detail: "git status", truncated: false };
  expect(askCardId({ ...base })).toBe(askCardId(base));
  expect(askCardId({ ...base, key: "bb" })).not.toBe(askCardId(base));
  expect(askCardId({ ...base, detail: "Remove-Item -Recurse $HOME" })).not.toBe(askCardId(base));
  expect(askCardId({ ...base, truncated: true })).not.toBe(askCardId(base));
});
