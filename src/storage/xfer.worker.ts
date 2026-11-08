// Transfer worker (design 7.3): hashing, chunk encryption and decryption off the main thread,
// and received files written straight to the Origin Private File System with a sync access
// handle, so a 100 MB file never sits in memory. The steps are the ones in core/transfer.ts.

import { sha256 } from "@noble/hashes/sha2.js";
import { BlobError, CHUNK, chunkLen, openChunk, type Plan, sealChunk } from "../core/transfer";
import { PREFIX } from "./opfs-name";

interface SyncHandle {
  write(data: Uint8Array, opts: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface OpenSink {
  plan: Plan;
  handle: SyncHandle;
  hash: ReturnType<typeof sha256.create>;
  at: number;
  next: number;
}

const sinks = new Map<string, OpenSink>();
const scope = self as unknown as { onmessage: ((ev: MessageEvent) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void };

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function closeSink(fid: string, remove: boolean) {
  const s = sinks.get(fid);
  sinks.delete(fid);
  try {
    s?.handle.close();
  } catch {
    /* already closed */
  }
  if (remove) await (await root()).removeEntry(PREFIX + fid).catch(() => {});
}

type Out = [unknown, Transferable[]];

async function run(id: number, op: string, a: Record<string, any>): Promise<Out> {
  switch (op) {
    case "hash": {
      const file = a.file as Blob;
      const h = sha256.create();
      for (let at = 0; at < file.size; at += CHUNK) {
        h.update(new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()));
        scope.postMessage({ id, progress: Math.min(file.size, at + CHUNK) });
      }
      return [h.digest(), []];
    }
    case "seal": {
      const plan = a.plan as Plan;
      const i = a.i as number;
      const data = new Uint8Array(await (a.file as Blob).slice(i * CHUNK, i * CHUNK + chunkLen(plan, i)).arrayBuffer());
      if (data.length !== chunkLen(plan, i)) throw new BlobError("io");
      const out = sealChunk(plan, "p2c", i, data);
      return [out, [out.buffer as ArrayBuffer]];
    }
    case "open": {
      const plan = a.plan as Plan;
      await closeSink(plan.fidHex, true);
      const fh = await (await root()).getFileHandle(PREFIX + plan.fidHex, { create: true });
      const handle = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()) as SyncHandle;
      handle.truncate(0);
      sinks.set(plan.fidHex, { plan, handle, hash: sha256.create(), at: 0, next: 0 });
      return [null, []];
    }
    case "write": {
      const s = sinks.get(a.fid);
      const plain = s && a.i === s.next ? openChunk(s.plan, "c2p", a.i, a.blob as Uint8Array) : null;
      if (!s || !plain) throw new BlobError("corrupt");
      if (s.handle.write(plain, { at: s.at }) !== plain.length) throw new BlobError("storage");
      s.hash.update(plain);
      s.at += plain.length;
      s.next++;
      return [null, []];
    }
    case "finish": {
      const s = sinks.get(a.fid);
      if (!s || s.next !== s.plan.chunks) throw new BlobError("corrupt");
      s.handle.flush();
      const sha = s.hash.digest();
      await closeSink(a.fid, false);
      return [sha, []];
    }
    case "abort":
      await closeSink(a.fid, true);
      return [null, []];
    default:
      throw new BlobError("invalid");
  }
}

scope.onmessage = (ev: MessageEvent) => {
  const { id, op, a } = ev.data as { id: number; op: string; a: Record<string, unknown> };
  run(id, op, a).then(
    ([r, transfer]) => scope.postMessage({ id, ok: true, r }, transfer),
    (e) => {
      const name = (e as { name?: string })?.name;
      const code = e instanceof BlobError ? e.code : name === "QuotaExceededError" ? "storage" : "io";
      scope.postMessage({ id, ok: false, e: code });
    },
  );
};
