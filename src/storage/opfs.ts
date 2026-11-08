// The browser's FileCrypto and FileShelf: a Web Worker (xfer.worker.ts) does the hashing and
// the chunk crypto, and received files are written to and read from OPFS (design 7.3).

import { BlobError, type FileCrypto, type FileShelf, type Plan, type Sink, type XferError } from "../core/transfer";
import { PREFIX } from "./opfs-name";

type Call = { resolve: (v: any) => void; reject: (e: unknown) => void; progress?: (n: number) => void };

export class WorkerFiles implements FileCrypto, FileShelf {
  private worker: Worker | null = null;
  private next = 0;
  private calls = new Map<number, Call>();

  private w(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./xfer.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { id: number; ok?: boolean; r?: unknown; e?: XferError; progress?: number };
      const c = this.calls.get(m.id);
      if (!c) return;
      if (typeof m.progress === "number") {
        c.progress?.(m.progress);
        return;
      }
      this.calls.delete(m.id);
      if (m.ok) c.resolve(m.r);
      else c.reject(new BlobError(m.e ?? "io"));
    };
    w.onerror = () => {
      for (const [, c] of this.calls) c.reject(new BlobError("io"));
      this.calls.clear();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private call<T>(op: string, a: Record<string, unknown>, transfer: Transferable[] = [], progress?: (n: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.next;
      this.calls.set(id, { resolve, reject, progress });
      this.w().postMessage({ id, op, a }, transfer);
    });
  }

  hash(file: Blob, onProgress?: (done: number) => void) {
    return this.call<Uint8Array>("hash", { file }, [], onProgress);
  }

  seal(file: Blob, plan: Plan, i: number) {
    return this.call<Uint8Array>("seal", { file, plan, i });
  }

  async sink(plan: Plan): Promise<Sink> {
    await this.call("open", { plan });
    const fid = plan.fidHex;
    return {
      write: (i, blob) => {
        const exact = blob.byteOffset === 0 && blob.byteLength === blob.buffer.byteLength;
        return this.call("write", { fid, i, blob }, exact ? [blob.buffer as ArrayBuffer] : []);
      },
      finish: () => this.call<Uint8Array>("finish", { fid }),
      abort: () => this.call("abort", { fid }),
    };
  }

  async get(fid: string): Promise<Blob | null> {
    try {
      const dir = await navigator.storage.getDirectory();
      return await (await dir.getFileHandle(PREFIX + fid)).getFile();
    } catch {
      return null;
    }
  }

  async remove(fid: string) {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(PREFIX + fid).catch(() => {});
  }

  async list(): Promise<string[]> {
    const dir = await navigator.storage.getDirectory();
    const out: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) if (name.startsWith(PREFIX)) out.push(name.slice(PREFIX.length));
    return out;
  }
}

/** Transfers need a module worker and OPFS (Chrome on Android has both). */
export function browserFiles(): WorkerFiles | undefined {
  return typeof Worker !== "undefined" && typeof navigator !== "undefined" && !!navigator.storage?.getDirectory ? new WorkerFiles() : undefined;
}
