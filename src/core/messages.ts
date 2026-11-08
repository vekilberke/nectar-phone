// Inner messages (design 6.4, 6.5, appendix B). PC-to-phone messages are validated here
// before the UI sees them; anything unexpected is dropped.

import { cleanText } from "./protocol";

export interface Perms {
  media?: boolean;
  volume?: boolean;
  lock?: boolean;
  status?: boolean;
  mediaInfo?: boolean;
  agentStatus?: boolean;
  agentAsk?: boolean;
  clipboard?: boolean;
  filesIn?: boolean;
  textIn?: boolean;
  filesOut?: boolean;
  textOut?: boolean;
  openUrl?: "off" | "ask" | "on";
}

export type Op =
  | "media.play_pause"
  | "media.next"
  | "media.previous"
  | "volume.set"
  | "volume.mute"
  | "volume.up"
  | "volume.down"
  | "pc.lock"
  | "url.open"
  | "clipboard.set"
  | "status.get"
  | "agent.answer";

/** Which permission each op needs (mirrors `remote::authorize`). */
export function opAllowed(perms: Perms, op: Op): boolean {
  switch (op) {
    case "media.play_pause":
    case "media.next":
    case "media.previous":
      return !!perms.media;
    case "volume.set":
    case "volume.mute":
    case "volume.up":
    case "volume.down":
      return !!perms.volume;
    case "pc.lock":
      return !!perms.lock;
    case "url.open":
      return perms.openUrl === "on" || perms.openUrl === "ask";
    case "clipboard.set":
      return !!perms.clipboard;
    case "status.get":
      return !!perms.status;
    case "agent.answer":
      return !!perms.agentAsk;
  }
}

export const MAX_TEXT = 64 * 1024;
/** The PC's limit for a sealed message's plaintext (engine.rs `MAX_CIPHERTEXT`). */
export const MAX_INNER = 64 * 1024;
/** At least the PC's limit for an ask's command (agent_api.rs `ASK_FULL`). */
export const MAX_ASK_DETAIL = 2000;
export const MAX_URL = 2048;

export interface Ask {
  id: number;
  /** Random per ask on the PC; the answer carries it, so a card can only ever answer its own ask. */
  key: string;
  name: string;
  project: string;
  tool: string;
  detail: string;
  /** The PC or the phone cut `detail`: the phone must not approve what it cannot show. */
  truncated: boolean;
}

/** A card's identity: the PC's id and per-ask key plus what it shows, so new content is a new card that arms again. */
export const askCardId = (a: Ask) => `${a.id}:${a.key}:${a.truncated ? 1 : 0}:${a.tool}:${a.detail}`;

export interface Status {
  battery: { percent: number; charging: boolean } | null;
  media: { playing: boolean; title?: string; artist?: string } | null;
  volume: { level: number; muted: boolean } | null;
  agent: { state: string; name: string; project: string } | null;
  locked: boolean;
  asks?: Ask[];
  /** Asks waiting on the PC that did not fit in this status. */
  asksMore?: number;
  /** The PC's limit for files from the phone, in MB (sent with `filesIn`). */
  maxInMb?: number;
}

export type ResError = "denied" | "invalid" | "busy" | "failed" | "timeout" | "offline" | "tooLong" | "tooBig" | "unsupported" | "network" | "corrupt" | "io" | "disk" | "storage" | "expired" | "folder";

export type PcMessage =
  | { t: "res"; id: number; ok: true; d: unknown }
  | { t: "res"; id: number; ok: false; e: ResError }
  | { t: "status"; d: Status }
  | { t: "perms"; d: Perms }
  | { t: "text"; text: string }
  | { t: "rekey"; ep: number }
  | { t: "bye" }
  | { t: "relink" }
  | { t: "reject"; fid: string; e: string }
  | { t: "offer"; offer: Record<string, unknown> }
  | { t: "accept" | "done" | "saved"; fid: string };

const isFid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const str = (v: unknown, limit: number) => (typeof v === "string" ? cleanText(v, limit) : "");
/** Like `cleanText` but keeps line breaks; format characters (bidi overrides) are dropped so the shown order is the real one. */
export function cleanDetail(text: string): string {
  return text
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/\p{Cf}|(?!\n)\p{Cc}/gu, "")
    .replace(/^\n+|\s+$/g, "");
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseStatus(v: unknown): Status | null {
  const o = obj(v);
  if (!o) return null;
  const b = obj(o.battery);
  const m = obj(o.media);
  const vol = obj(o.volume);
  const a = obj(o.agent);
  const status: Status = {
    battery: b && num(b.percent, 0, 100) !== null ? { percent: num(b.percent, 0, 100)!, charging: b.charging === true } : null,
    media: m ? { playing: m.playing === true, title: str(m.title, 200) || undefined, artist: str(m.artist, 200) || undefined } : null,
    volume: vol && num(vol.level, 0, 1) !== null ? { level: num(vol.level, 0, 1)!, muted: vol.muted === true } : null,
    agent: a && typeof a.state === "string" ? { state: str(a.state, 40), name: str(a.name, 60), project: str(a.project, 80) } : null,
    locked: o.locked === true,
  };
  if (Array.isArray(o.asks)) {
    status.asks = o.asks
      .map(obj)
      // Without its key an ask cannot be answered from here (an older PC): leave it to the PC.
      .filter((x): x is Record<string, unknown> => !!x && typeof x.id === "number" && Number.isSafeInteger(x.id) && x.id >= 0 && typeof x.key === "string" && /^[0-9a-f]{1,32}$/i.test(x.key))
      .slice(0, 20)
      .map((x) => {
        const raw = typeof x.full === "string" ? x.full : typeof x.detail === "string" ? x.detail : "";
        const chars = Array.from(cleanDetail(raw));
        const detail = chars.slice(0, MAX_ASK_DETAIL).join("");
        // An old PC sends only `detail`, which it cut to one line of 200 characters without saying so.
        const truncated = x.truncated === true || (typeof x.full !== "string" && chars.length > 0) || chars.length > MAX_ASK_DETAIL;
        return { id: x.id as number, key: x.key as string, name: str(x.name, 60), project: str(x.project, 80), tool: str(x.tool, 60), detail, truncated };
      });
    const more = num(o.asksMore, 0, 1000);
    if (more) status.asksMore = Math.floor(more);
  }
  const maxIn = num(o.maxInMb, 1, 200);
  if (maxIn) status.maxInMb = Math.floor(maxIn);
  return status;
}

const RES_ERRORS = new Set(["denied", "invalid", "busy", "failed"]);

export function parsePcMessage(v: Record<string, unknown>): PcMessage | null {
  switch (v.t) {
    case "res":
      if (typeof v.id !== "number" || !Number.isSafeInteger(v.id)) return null;
      if (v.ok === true) return { t: "res", id: v.id, ok: true, d: v.d ?? null };
      if (v.ok === false) return { t: "res", id: v.id, ok: false, e: (RES_ERRORS.has(v.e as string) ? v.e : "failed") as ResError };
      return null;
    case "evt": {
      if (v.op === "status") {
        const d = parseStatus(v.d);
        return d ? { t: "status", d } : null;
      }
      if (v.op === "perms") {
        const d = obj(v.d);
        return d ? { t: "perms", d: d as Perms } : null;
      }
      return null;
    }
    case "text":
      return typeof v.text === "string" && v.text.length > 0 && v.text.length <= MAX_TEXT ? { t: "text", text: v.text } : null;
    case "rekey":
      return typeof v.ep === "number" && Number.isSafeInteger(v.ep) && v.ep > 0 ? { t: "rekey", ep: v.ep } : null;
    case "bye":
      return { t: "bye" };
    case "relink":
      return { t: "relink" };
    case "reject":
      return isFid(v.fid) ? { t: "reject", fid: v.fid, e: str(v.e, 40) } : null;
    case "offer":
      return isFid(v.fid) ? { t: "offer", offer: v } : null;
    case "accept":
    case "done":
    case "saved":
      return isFid(v.fid) && Object.keys(v).length === 2 ? { t: v.t, fid: v.fid } : null;
    default:
      return null;
  }
}

/** Client-side check before `url.open`; the PC checks again. */
export function normalizeUrl(raw: string): string | null {
  let text = raw.trim();
  if (!text || text.length > MAX_URL) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;
  try {
    const u = new URL(text);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
    return u.href.length <= MAX_URL ? u.href : null;
  } catch {
    return null;
  }
}
