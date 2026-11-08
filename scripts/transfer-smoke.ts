// Transfer smoke test against the real relay, without a PC owner (I-104): two anonymous users
// share a test topic that the orchestrator creates with SQL, then the PWA's transfer code
// moves a file and a mailbox item each way through link-upload and Storage.
//
//   bun scripts/transfer-smoke.ts setup <state.json>   signs up "pc" and "phone", prints the SQL
//   bun scripts/transfer-smoke.ts run <state.json>     runs the transfers and the negative checks
//
// The state file holds two short-lived anonymous sessions: keep it outside the repo and
// delete it afterwards. Clean-up SQL is printed at the end.

import { readFileSync, writeFileSync } from "node:fs";
import config from "../relay.config.json";
import { hex, randomBytes } from "../src/core/bytes";
import { type AuthSession, RelayBlobs, Rest } from "../src/core/relay";
import {
  BlobError,
  blobPath,
  CHUNK,
  discard,
  InlineCrypto,
  mboxPath,
  mboxPrefix,
  newPlan,
  offerOf,
  openChunk,
  openMailbox,
  planOf,
  receiveFile,
  sealChunk,
  sealMailbox,
  uploadFile,
  uploadMailbox,
} from "../src/core/transfer";

const [phase, file] = process.argv.slice(2);
const rest = new Rest(config);
const now = () => Math.floor(Date.now() / 1000);
const log = (...a: unknown[]) => console.log(...a);

if (phase === "setup" && file) {
  const pc = await rest.signupAnonymous(now());
  const phone = await rest.signupAnonymous(now());
  const topic = "nl-" + hex(randomBytes(16));
  writeFileSync(file, JSON.stringify({ pc, phone, topic }));
  log(`insert into public.link_topics (topic, rejoin_key) values ('${topic}', extensions.gen_random_bytes(32));`);
  log(`insert into public.link_members (topic, role, member) values ('${topic}', 'pc', '${pc.userId}'), ('${topic}', 'phone', '${phone.userId}');`);
  process.exit(0);
}

if (phase !== "run" || !file) {
  console.error("usage: transfer-smoke.ts setup|run <state.json>");
  process.exit(2);
}

const state = JSON.parse(readFileSync(file, "utf8")) as { pc: AuthSession; phone: AuthSession; topic: string };
const { topic } = state;
const asPc = new RelayBlobs(config, () => state.pc.accessToken);
const asPhone = new RelayBlobs(config, () => state.phone.accessToken);
const crypto = new InlineCrypto();
const kDev = randomBytes(32);
let failures = 0;
const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof BlobError ? e.code : String(e)));

// Phone to PC: two chunks and a mailbox offer.
const data = randomBytes(CHUNK + 4321);
const plan = newPlan("smoke photo.jpg", data.length, "image/jpeg", await crypto.hash(new Blob([data as BlobPart])))!;
await uploadFile(asPhone, crypto, topic, new Blob([data as BlobPart]), plan, () => {});
await uploadMailbox(asPhone, topic, plan.fidHex, sealMailbox(kDev, 0, topic, "p2c", plan.fid, now(), offerOf(plan)));
check(true, "phone uploaded 2 chunks and a mailbox item through signed URLs");
const listed = await asPc.list(mboxPrefix(topic, "p2c"));
check(listed.includes(plan.fidHex), "PC lists the p2c mailbox");
const inner = openMailbox((ep) => (ep === 0 ? kDev : null), topic, "p2c", plan.fid, await asPc.get(mboxPath(topic, "p2c", plan.fidHex)), now());
const offered = planOf(inner);
check(offered?.fidHex === plan.fidHex, "PC opens the mailbox offer");
const parts = [0, 1].map(async (i) => openChunk(offered!, "p2c", i, await asPc.get(blobPath(topic, "p2c", plan.fidHex, i))));
const got = await Promise.all(parts);
check(!!got[0] && !!got[1] && hex(new Uint8Array([...got[0]!, ...got[1]!])) === hex(data), "PC downloads and decrypts both chunks");
check((await code(asPhone.release(topic, "p2c", plan.fidHex, "blob"))) === "denied", "the sender may not release a p2c grant");
await discard(asPc, topic, "p2c", plan.fidHex, plan.chunks, true);
check((await asPc.list(mboxPrefix(topic, "p2c"))).length === 0, "PC deleted the objects and released both grants");

// PC to phone: one chunk, received with the PWA's receiveFile.
const back = randomBytes(1000);
const out = newPlan("from pc.pdf", back.length, "application/pdf", await crypto.hash(new Blob([back as BlobPart])))!;
const [u] = await asPc.authorize(topic, "c2p", out.fidHex, 1, "blob");
await asPc.put(u, sealChunk(out, "c2p", 0, back));
await receiveFile(asPhone, crypto, topic, out, () => {});
check(hex(crypto.files.get(out.fidHex)!) === hex(back), "phone receives and verifies the PC's file");
await discard(asPhone, topic, "c2p", out.fidHex, 1, false);
check((await code(asPhone.get(blobPath(topic, "c2p", out.fidHex, 0)))) !== "ok", "phone deleted the c2p object");

// Direction and membership are enforced by link-upload.
check((await code(asPhone.authorize(topic, "c2p", hex(randomBytes(16)), 1, "blob"))) === "denied", "the phone cannot upload PC-to-phone");
check((await code(asPc.authorize(topic, "p2c", hex(randomBytes(16)), 1, "blob"))) === "denied", "the PC cannot upload phone-to-PC");
const stranger = await rest.signupAnonymous(now());
const asStranger = new RelayBlobs(config, () => stranger.accessToken);
check((await code(asStranger.authorize(topic, "p2c", hex(randomBytes(16)), 1, "blob"))) === "denied", "a stranger gets no upload URL");
check((await code(asStranger.list(mboxPrefix(topic, "c2p")).then((l) => (l.length ? l : Promise.reject(new BlobError("denied")))))) === "denied", "a stranger lists nothing");

log(`\nclean-up SQL:\ndelete from public.link_topics where topic = '${topic}';`);
log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
