import { expect, test } from "bun:test";
import { b64u, concat, equalBytes, fromUtf8, hex, u32be, u64be, unb64u, unb64uLen, unhex } from "../src/core/bytes";

test("base64url is strict: no padding, no other alphabet, no non-canonical tails", () => {
  const bytes = new Uint8Array([251, 255, 254, 1, 2]);
  const text = b64u(bytes);
  expect(text).toBe("-__-AQI");
  expect(unb64u(text)).toEqual(bytes);
  expect(unb64u(text + "=")).toBeNull();
  expect(unb64u("+/+/")).toBeNull();
  expect(unb64u("A")).toBeNull(); // length % 4 === 1
  expect(unb64u("AB")).toBeNull(); // trailing bits set: not the canonical encoding
  expect(unb64u(12)).toBeNull();
  expect(unb64u("")).toEqual(new Uint8Array());
  expect(unb64uLen(b64u(new Uint8Array(32)), 32)?.length).toBe(32);
  expect(unb64uLen(b64u(new Uint8Array(31)), 32)).toBeNull();
});

test("hex, integers and concat", () => {
  expect(hex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  expect(unhex("000fFF")).toEqual(new Uint8Array([0, 15, 255]));
  expect(unhex("abc")).toBeNull();
  expect(unhex("zz")).toBeNull();
  expect(u32be(0x01020304)).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(u32be(2 ** 32 + 5)).toEqual(new Uint8Array([0, 0, 0, 5])); // wraps like the Rust u32
  expect(u64be(1)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
  expect(u64be(2n ** 63n)[0]).toBe(0x80);
  expect(concat(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
});

test("utf8 decoding rejects invalid sequences; equalBytes checks length and content", () => {
  expect(fromUtf8(new Uint8Array([0xc3, 0x28]))).toBeNull();
  expect(fromUtf8(new Uint8Array([0xc3, 0xa7]))).toBe("ç");
  expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
});
