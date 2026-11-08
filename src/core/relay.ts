// Supabase relay client for the phone: Auth and RPC over REST, Realtime broadcast over the
// Phoenix protocol (vsn 1.0.0), the same frames the PC speaks (src-tauri/.../supabase.rs).
// Written by hand instead of supabase-js: a few hundred lines we can audit, no extra
// dependencies in a page that holds device keys (design section 12, host compromise).

import { BlobError, type Blobs, type Dir } from "./transfer";

export interface RelayConfig {
  ref: string;
  url: string;
  anonKey: string;
  pwaUrl: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  userId: string;
}

export class RelayError extends Error {
  constructor(
    readonly kind: "network" | "paused" | "status",
    readonly status = 0,
    message: string = kind,
  ) {
    super(message);
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseAuth(body: unknown, nowSecs: number): AuthSession | null {
  const b = body as Record<string, unknown> | null;
  const user = b?.user as Record<string, unknown> | undefined;
  if (!b || typeof b.access_token !== "string" || typeof b.refresh_token !== "string" || typeof user?.id !== "string" || !UUID.test(user.id)) return null;
  const expiresAt = typeof b.expires_at === "number" ? b.expires_at : nowSecs + (typeof b.expires_in === "number" ? b.expires_in : 3600);
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt, userId: user.id };
}

function errorMessage(body: unknown, fallback: string): string {
  const b = body as Record<string, unknown> | null;
  for (const k of ["message", "msg", "error_description", "error"]) if (typeof b?.[k] === "string") return b[k] as string;
  return fallback.slice(0, 200);
}

export class Rest {
  constructor(
    readonly cfg: RelayConfig,
    private readonly fetchFn: FetchFn = (i, o) => fetch(i, o),
  ) {}

  private async send(path: string, body: unknown, token?: string): Promise<unknown> {
    let resp: Response;
    try {
      resp = await this.fetchFn(this.cfg.url + path, {
        method: "POST",
        headers: { apikey: this.cfg.anonKey, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
      });
    } catch (e) {
      throw new RelayError("network", 0, String(e));
    }
    const text = await resp.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (resp.status === 540 || (resp.status === 503 && json === null)) throw new RelayError("paused", resp.status);
    if (!resp.ok) throw new RelayError("status", resp.status, errorMessage(json, text));
    return json;
  }

  async signupAnonymous(nowSecs: number): Promise<AuthSession> {
    const a = parseAuth(await this.send("/auth/v1/signup", {}), nowSecs);
    if (!a) throw new RelayError("status", 200, "bad auth response");
    return a;
  }

  async refresh(refreshToken: string, nowSecs: number): Promise<AuthSession> {
    const a = parseAuth(await this.send("/auth/v1/token?grant_type=refresh_token", { refresh_token: refreshToken }), nowSecs);
    if (!a) throw new RelayError("status", 200, "bad auth response");
    return a;
  }

  rpc(token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.send(`/rest/v1/rpc/${name}`, args, token);
  }
}

/** Maps a failed Storage or Edge Function call onto the transfer error codes (like the PC's `xfer_error`). */
export function blobError(e: unknown): BlobError {
  if (e instanceof BlobError) return e;
  if (!(e instanceof RelayError) || e.kind !== "status") return new BlobError("network");
  if (e.status === 403) return new BlobError("denied");
  if (e.status === 429 || e.status === 507) return new BlobError("busy");
  return new BlobError(e.status >= 500 ? "network" : "invalid");
}

/**
 * The link-blobs bucket over the relay (design 7.1): `link-upload` for signed upload URLs
 * and releases, then plain HTTPS to Storage. `token` is read on every call, so a refreshed
 * access token is picked up by a transfer in progress.
 */
export class RelayBlobs implements Blobs {
  constructor(
    private readonly cfg: RelayConfig,
    private readonly token: () => string,
    private readonly fetchFn: FetchFn = (i, o) => fetch(i, o),
  ) {}

  private async call(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}, auth = true): Promise<Response> {
    let resp: Response;
    try {
      resp = await this.fetchFn(path.startsWith("https://") ? path : this.cfg.url + path, {
        method,
        headers: { apikey: this.cfg.anonKey, ...(auth ? { authorization: `Bearer ${this.token()}` } : {}), ...headers },
        body,
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new BlobError("network");
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw blobError(resp.status === 540 ? new RelayError("paused", 540) : new RelayError("status", resp.status, text.slice(0, 200)));
    }
    return resp;
  }

  private async fn(body: object): Promise<Record<string, unknown>> {
    const r = await this.call("POST", "/functions/v1/link-upload", JSON.stringify(body), { "content-type": "application/json" });
    return (await r.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async authorize(topic: string, dir: Dir, fid: string, count: number, kind: "blob" | "mailbox"): Promise<string[]> {
    const v = await this.fn({ topic, dir, fid, count, kind });
    if (!Array.isArray(v.uploads)) throw new BlobError("network");
    return v.uploads.map((u: { path?: unknown; token?: unknown }) => {
      const url = typeof u.path === "string" && u.path.startsWith(topic + "/") && typeof u.token === "string" ? signedUploadUrl(this.cfg, u.path, u.token) : null;
      if (!url) throw new BlobError("network");
      return url;
    });
  }

  async put(url: string, body: Uint8Array): Promise<void> {
    // The token in the URL authorizes the upload; no user token goes with it.
    await this.call("PUT", url, body as BodyInit, { "x-upsert": "true", "content-type": "application/octet-stream" }, false);
  }

  async get(path: string): Promise<Uint8Array> {
    const r = await this.call("GET", `/storage/v1/object/authenticated/link-blobs/${path}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async delete(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 100) {
      await this.call("DELETE", "/storage/v1/object/link-blobs", JSON.stringify({ prefixes: paths.slice(i, i + 100) }), { "content-type": "application/json" });
    }
  }

  async release(topic: string, dir: Dir, fid: string, kind: "blob" | "mailbox"): Promise<void> {
    await this.fn({ op: "release", topic, dir, fid, kind });
  }

  async list(prefix: string): Promise<string[]> {
    const r = await this.call("POST", "/storage/v1/object/list/link-blobs", JSON.stringify({ prefix, limit: 100, offset: 0 }), { "content-type": "application/json" });
    const items = (await r.json().catch(() => [])) as { name?: unknown; id?: unknown }[];
    return Array.isArray(items) ? items.filter((i) => typeof i.name === "string" && i.id != null).map((i) => i.name as string) : [];
  }
}

/** Upload URL for a path and token from `link-upload` (the PC builds the same in `signed_upload_url`). */
export function signedUploadUrl(cfg: RelayConfig, path: string, token: string): string | null {
  if (!/^[A-Za-z0-9_/-]+$/.test(path) || !/^[A-Za-z0-9_.-]+$/.test(token)) return null;
  return `${cfg.url}/storage/v1/object/upload/sign/link-blobs/${path}?token=${token}`;
}

/** Postgres `bytea` input as PostgREST expects it, like the PC's `client::bytea`. */
export function bytea(bytes: Uint8Array): string {
  let s = "\\x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// Realtime.

export interface Frame {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string | null;
  join_ref?: string | null;
}

export const channel = (topic: string) => `realtime:${topic}`;

export function joinFrame(topic: string, ref: number, token: string): Frame {
  return {
    topic: channel(topic),
    event: "phx_join",
    payload: { config: { broadcast: { self: false, ack: true }, presence: { key: "phone" }, private: true }, access_token: token },
    ref: String(ref),
    join_ref: String(ref),
  };
}

export function broadcastFrame(topic: string, event: string, body: unknown, ref: number, joinRef: number): Frame {
  return { topic: channel(topic), event: "broadcast", payload: { type: "broadcast", event, payload: body }, ref: String(ref), join_ref: String(joinRef) };
}

export const heartbeatFrame = (ref: number): Frame => ({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref) });
export const leaveFrame = (topic: string, ref: number, joinRef: number): Frame => ({ topic: channel(topic), event: "phx_leave", payload: {}, ref: String(ref), join_ref: String(joinRef) });
export const tokenFrame = (topic: string, token: string, ref: number, joinRef: number): Frame => ({
  topic: channel(topic),
  event: "access_token",
  payload: { access_token: token },
  ref: String(ref),
  join_ref: String(joinRef),
});

export function parseFrame(text: string): Frame | null {
  try {
    const f = JSON.parse(text);
    if (!f || typeof f.topic !== "string" || typeof f.event !== "string") return null;
    return { topic: f.topic, event: f.event, payload: f.payload && typeof f.payload === "object" ? f.payload : {}, ref: f.ref ?? null, join_ref: f.join_ref ?? null };
  } catch {
    return null;
  }
}

export class JoinError extends Error {
  constructor(readonly kind: "unauthorized" | "timeout" | "closed" | "error", message: string = kind) {
    super(message);
  }
}

/** The broadcast transport the link uses; `Realtime` in the app, fakes in tests. */
export interface Channel {
  join(topic: string, token: string): Promise<void>;
  leave(topic: string): void;
  send(topic: string, event: string, payload: unknown): Promise<void>;
  setToken(token: string): void;
  close(): void;
  onBroadcast: (topic: string, event: string, payload: unknown) => void;
  onClose: () => void;
}

export const HEARTBEAT_MS = 25_000;
const REPLY_MS = 10_000;

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

export class Realtime implements Channel {
  onBroadcast: Channel["onBroadcast"] = () => {};
  onClose: Channel["onClose"] = () => {};
  private ws: WsLike | null = null;
  private opened: Promise<void> | null = null;
  private ref = 0;
  private joins = new Map<string, number>();
  private waiting = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pendingHeartbeat: string | null = null;
  private closed = false;

  constructor(
    private readonly cfg: RelayConfig,
    private readonly makeWs: WsFactory = (url) => new WebSocket(url) as unknown as WsLike,
  ) {}

  private url() {
    return `wss://${this.cfg.ref}.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(this.cfg.anonKey)}&vsn=1.0.0`;
  }

  private open(): Promise<void> {
    if (this.opened) return this.opened;
    this.opened = new Promise((resolve, reject) => {
      const ws = this.makeWs(this.url());
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new JoinError("timeout", "websocket open timeout"));
        this.close();
      }, REPLY_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
        resolve();
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new JoinError("closed"));
        this.shutdown();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") this.onFrame(ev.data);
      };
    });
    return this.opened;
  }

  private beat() {
    if (this.pendingHeartbeat) {
      // The last heartbeat got no reply: the socket is dead even if it still looks open.
      this.close();
      return;
    }
    this.pendingHeartbeat = String(++this.ref);
    this.raw(heartbeatFrame(this.ref));
  }

  private raw(f: Frame) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(f));
  }

  private onFrame(text: string) {
    const f = parseFrame(text);
    if (!f) return;
    if (f.event === "phx_reply" && f.ref) {
      if (f.ref === this.pendingHeartbeat) this.pendingHeartbeat = null;
      const w = this.waiting.get(f.ref);
      if (w) {
        clearTimeout(w.timer);
        this.waiting.delete(f.ref);
        w.resolve(f);
      }
      return;
    }
    if (f.event === "broadcast" && f.topic.startsWith("realtime:")) {
      const p = f.payload;
      if (typeof p.event === "string") this.onBroadcast(f.topic.slice(9), p.event, p.payload ?? null);
      return;
    }
    if ((f.event === "phx_error" || f.event === "phx_close") && f.topic.startsWith("realtime:")) {
      const topic = f.topic.slice(9);
      if (this.joins.has(topic) && f.join_ref === String(this.joins.get(topic))) {
        // The server dropped our channel (e.g. token expired, membership changed).
        this.close();
      }
    }
  }

  private request(f: Frame): Promise<Frame> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new JoinError("closed"));
        return;
      }
      const timer = setTimeout(() => {
        this.waiting.delete(f.ref!);
        reject(new JoinError("timeout"));
      }, REPLY_MS);
      this.waiting.set(f.ref!, { resolve, reject, timer });
      this.raw(f);
    });
  }

  async join(topic: string, token: string): Promise<void> {
    if (this.closed) throw new JoinError("closed");
    await this.open();
    const ref = ++this.ref;
    const reply = await this.request(joinFrame(topic, ref, token));
    const status = reply.payload.status;
    if (status !== "ok") {
      const reason = JSON.stringify(reply.payload.response ?? "");
      throw new JoinError(/unauthori[sz]ed|permission|not allowed|denied/i.test(reason) ? "unauthorized" : "error", reason);
    }
    this.joins.set(topic, ref);
  }

  leave(topic: string) {
    const j = this.joins.get(topic);
    if (j === undefined) return;
    this.joins.delete(topic);
    this.raw(leaveFrame(topic, ++this.ref, j));
  }

  async send(topic: string, event: string, payload: unknown): Promise<void> {
    const j = this.joins.get(topic);
    if (j === undefined) throw new JoinError("closed", "not joined");
    const reply = await this.request(broadcastFrame(topic, event, payload, ++this.ref, j));
    if (reply.payload.status !== "ok") throw new JoinError("error", JSON.stringify(reply.payload.response ?? ""));
  }

  setToken(token: string) {
    for (const [topic, j] of this.joins) this.raw(tokenFrame(topic, token, ++this.ref, j));
  }

  get isOpen() {
    return !this.closed && this.ws?.readyState === 1;
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new JoinError("closed"));
    }
    this.waiting.clear();
    this.joins.clear();
    this.onClose();
  }

  close() {
    const ws = this.ws;
    this.shutdown();
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }
}
