// IndexedDB store for the device record and the relay session, in one database so both are
// kept or lost together (design 5.3).

import type { ReceivedFile, Store } from "../core/link";
import type { DeviceRecord } from "../core/protocol";
import type { AuthSession } from "../core/relay";

const DB = "nectar-link";
const KV = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(KV);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

export class IdbStore implements Store {
  private db: Promise<IDBDatabase> | null = null;

  private conn() {
    this.db ??= openDb();
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.conn();
    return new Promise((resolve, reject) => {
      const t = db.transaction(KV, mode);
      const req = fn(t.objectStore(KV));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  private get<T>(key: string) {
    return this.tx<T>("readonly", (s) => s.get(key) as IDBRequest<T>);
  }

  private put(key: string, value: unknown) {
    return this.tx<unknown>("readwrite", (s) => (value === null ? s.delete(key) : s.put(value, key)) as IDBRequest<unknown>).then(() => undefined);
  }

  async load() {
    const [device, auth] = await Promise.all([this.get<DeviceRecord>("device"), this.get<AuthSession>("auth")]);
    return { device: device && device.v === 1 ? device : null, auth: auth ?? null };
  }

  saveDevice(d: DeviceRecord | null) {
    return this.put("device", d);
  }

  saveAuth(a: AuthSession | null) {
    return this.put("auth", a);
  }

  async loadFiles() {
    const [files, processed] = await Promise.all([this.get<ReceivedFile[]>("files"), this.get<Record<string, number>>("processed")]);
    return { files: Array.isArray(files) ? files : [], processed: processed && typeof processed === "object" ? processed : {} };
  }

  saveFiles(files: ReceivedFile[]) {
    return this.put("files", files);
  }

  saveProcessed(p: Record<string, number>) {
    return this.put("processed", p);
  }
}
