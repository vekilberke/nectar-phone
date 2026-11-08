// Reproduces every output of phone/test-vectors.json (written by the Rust tests) with the
// PWA's own crypto code, so both sides are byte-compatible.

import { expect, test } from "bun:test";
import vectors from "../test-vectors.json";
import { hex, unhex, utf8 } from "../src/core/bytes";
import * as c from "../src/core/crypto";

const I = vectors.inputs;
const O = vectors.outputs as Record<string, string>;
const h = (t: string) => unhex(t)!;

test("every shared test vector matches", () => {
  const ps = h(I.ps);
  const pcEph = c.keyPair(h(I.pcEphSecret));
  const phEph = c.keyPair(h(I.phEphSecret));
  const shared = c.agree(phEph, pcEph.public)!;
  expect(hex(c.agree(pcEph, phEph.public)!)).toBe(hex(shared));
  const k0 = c.deviceKey(shared, ps, pcEph.public, phEph.public);
  const sid = h(I.sid);
  const ePh = c.keyPair(h(I.ePhSecret));
  const ePc = c.keyPair(h(I.ePcSecret));
  const sShared = c.agree(ePh, ePc.public)!;
  const sk = c.sessionKeys(sShared, k0, sid, ePh.public, ePc.public);
  const topic = c.deviceTopic(k0);
  const fid = h(I.fid);

  const got: Record<string, string> = {
    pcEphPublic: hex(pcEph.public),
    phEphPublic: hex(phEph.public),
    pairShared: hex(shared),
    pairTopic: c.pairTopic(ps),
    helloKey: hex(c.helloKey(ps)),
    helloCiphertext: hex(c.sealWithNonce(c.helloKey(ps), h(I.helloNonce), c.helloAad(phEph.public), utf8(I.helloPlaintext))),
    deviceKey0: hex(k0),
    sas: c.sas(k0),
    deviceTopic: topic,
    rejoinKey: hex(c.rejoinKey(k0)),
    welcomeKey: hex(c.welcomeKey(k0)),
    welcomeCiphertext: hex(c.sealWithNonce(c.welcomeKey(k0), h(I.welcomeNonce), utf8("welcome"), utf8(I.welcomePlaintext))),
    ePhPublic: hex(ePh.public),
    ePcPublic: hex(ePc.public),
    hs1Mac: hex(c.hs1Mac(k0, sid, ePh.public, I.ts, I.ep)),
    hs2Mac: hex(c.hs2Mac(k0, sid, ePh.public, ePc.public)),
    sessionShared: hex(sShared),
    kP2c: hex(sk.p2c),
    kC2p: hex(sk.c2p),
    kRk: hex(sk.rk),
    deviceKey1: hex(c.rekey(k0, sk.rk, 1)),
    msgAad: hex(c.msgAad(topic, sid, c.DIR_P2C, 1)),
    msgCiphertext: hex(c.sealWithNonce(sk.p2c, h(I.msgNonce), c.msgAad(topic, sid, c.DIR_P2C, 1), utf8(I.msgPlaintext))),
    chunkAad: hex(c.chunkAad(c.DIR_C2P, fid, 0, true)),
    chunkCiphertext: hex(c.sealWithNonce(h(I.fileKey), h(I.chunkNonce), c.chunkAad(c.DIR_C2P, fid, 0, true), utf8(I.chunkPlaintext))),
    mailboxKeyC2p: hex(c.mailboxKey(k0, "c2p")),
    mailboxAad: hex(c.mailboxAad(topic, "c2p", fid, I.ts, 0)),
    mailboxCiphertext: hex(c.sealWithNonce(c.mailboxKey(k0, "c2p"), h(I.mboxNonce), c.mailboxAad(topic, "c2p", fid, I.ts, 0), utf8(I.mboxPlaintext))),
    ownerMac: hex(c.ownerMac(h(I.ownerKey), I.uid, I.ts)),
    rejoinMac: hex(c.rejoinMac(c.rejoinKey(k0), topic, I.uid, I.ts)),
  };
  expect(Object.keys(got).sort()).toEqual(Object.keys(O).sort());
  for (const [k, v] of Object.entries(O)) expect([k, got[k]]).toEqual([k, v]);
});

test("open rejects tampering and low-order keys are refused", () => {
  const key = new Uint8Array(32).fill(7);
  const sealed = c.seal(key, utf8("aad"), utf8("hi"));
  expect(new TextDecoder().decode(c.open(key, utf8("aad"), sealed)!)).toBe("hi");
  expect(c.open(key, utf8("aaX"), sealed)).toBeNull();
  sealed[30] ^= 1;
  expect(c.open(key, utf8("aad"), sealed)).toBeNull();
  expect(c.open(key, utf8("aad"), new Uint8Array(10))).toBeNull();
  expect(c.agree(c.keyPair(), new Uint8Array(32))).toBeNull();
});
