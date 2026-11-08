// Demo link for the demo build only (`bun run build:demo`, VITE_DEMO=1): canned screens for
// screenshots and audits without a PC. Not part of the production bundle.
//   ?demo=unpaired | pairing | pairing-error | remote | ask | send | transfer | waiting | revoked

import type { LinkApi, Result, Snapshot, TransferView } from "./core/link";
import type { Op, Perms } from "./core/messages";

const PERMS: Perms = {
  media: true,
  volume: true,
  lock: true,
  status: true,
  mediaInfo: true,
  agentStatus: true,
  agentAsk: true,
  clipboard: true,
  filesIn: true,
  textIn: true,
  filesOut: true,
  textOut: true,
  openUrl: "on",
};

const ASKS = [
  { id: 41, key: "a41f", name: "Claude Code", project: "nectar", tool: "Bash", detail: "cargo test --bin nectar phone_link -- --nocapture", truncated: false },
  { id: 42, key: "a42f", name: "Claude Code", project: "nectar", tool: "Edit", detail: "src-tauri/src/phone_link/engine.rs\n\nold_string:\nconst MAX: usize = 8;\n\nnew_string:\nconst MAX: usize = 16;", truncated: false },
  {
    id: 43,
    key: "a43f",
    name: "Claude Code",
    project: "nectar",
    tool: "Bash",
    detail: ["cd phone", "bun install --frozen-lockfile", "bun test tests", "bun run build", "bun run build:demo", "git status --short", "git add -A", "git commit -m \"Phone link p3\"", "git log --oneline -3", "ls dist"].join("\n"),
    truncated: false,
  },
];

function scenario(name: string): Snapshot {
  const now = Math.floor(Date.now() / 1000);
  const device = { pcName: "BERKE-PC", perms: PERMS, pairedAt: now - 86_400 * 3 };
  const status: Snapshot["status"] = {
    battery: { percent: 76, charging: true },
    media: { playing: true, title: "Weightless", artist: "Marconi Union" },
    volume: { level: 0.42, muted: false },
    agent: { state: "working", name: "Claude Code", project: "nectar" },
    locked: false,
    asks: [],
  };
  switch (name) {
    case "unpaired":
      return { device: null, conn: "idle", pairing: null, status: null, inbox: [], transfers: [], files: [] };
    case "pairing":
      return { device: null, conn: "idle", pairing: { step: "code", pcName: "BERKE-PC", expiresAt: now + 252, code: "187452" }, status: null, inbox: [], transfers: [], files: [] };
    case "pairing-error":
      return { device: null, conn: "idle", pairing: { step: "error", pcName: "BERKE-PC", expiresAt: now, error: "expired" }, status: null, inbox: [], transfers: [], files: [] };
    case "ask":
      return { device, conn: "online", pairing: null, status: { ...status, agent: { state: "needs_input", name: "Claude Code", project: "nectar" }, asks: ASKS, asksMore: 2 }, inbox: [], transfers: [], files: [] };
    case "send":
      return { device, conn: "online", pairing: null, status, inbox: [{ id: 1, text: "https://github.com/vekilberke/nectar-phone/actions", at: Date.now() }], transfers: [], files: [] };
    case "transfer": {
      const at = Date.now();
      const transfers: TransferView[] = [
        { id: "a1", dir: "p2c", name: "IMG_20261108_1412.jpg", size: 4_812_330, done: 2_900_000, state: "uploading", at },
        { id: "a2", dir: "c2p", name: "quarterly-report.pdf", size: 18_400_000, done: 6_100_000, state: "downloading", at: at - 2000 },
        { id: "a3", dir: "p2c", name: "voice-note.m4a", size: 912_000, done: 912_000, state: "saved", at: at - 60_000 },
        { id: "a4", dir: "p2c", name: "scan.pdf", size: 2_100_000, done: 2_100_000, state: "queued", at: at - 90_000 },
        { id: "a5", dir: "p2c", name: "big-video.mp4", size: 240_000_000, done: 0, state: "failed", e: "tooBig", at: at - 120_000 },
      ];
      const files = [{ fid: "f1", name: "boarding-pass.pdf", size: 312_000, mime: "application/pdf", at: at - 30_000 }];
      return { device, conn: "online", pairing: null, status, inbox: [], transfers, files };
    }
    case "waiting":
      return { device, conn: "waiting", pairing: null, status, inbox: [], transfers: [], files: [] };
    case "revoked":
      return { device, conn: "revoked", pairing: null, status: null, inbox: [], transfers: [], files: [] };
    default:
      return { device, conn: "online", pairing: null, status, inbox: [], transfers: [], files: [] };
  }
}

export class DemoLink implements LinkApi {
  private snap: Snapshot;
  private listeners = new Set<() => void>();

  constructor(name: string) {
    this.snap = scenario(name);
  }

  snapshot = () => this.snap;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }
  private status(patch: Partial<NonNullable<Snapshot["status"]>>) {
    if (this.snap.status) this.set({ status: { ...this.snap.status, ...patch } });
  }

  async start() {}
  stop() {}
  setVisible() {}
  leave() {}
  reconnect() {
    this.set({ conn: "online" });
  }
  async pair() {}
  cancelPairing() {
    this.set({ pairing: null });
  }
  clearPairingView() {
    this.set({ pairing: null });
  }
  async sendFile(file: File): Promise<Result> {
    const id = "d" + Date.now();
    this.set({ transfers: [{ id, dir: "p2c", name: file.name, size: file.size, done: 0, state: "uploading", at: Date.now() }, ...this.snap.transfers] });
    for (let i = 1; i <= 4; i++) {
      await new Promise((r) => setTimeout(r, 120));
      this.set({ transfers: this.snap.transfers.map((t) => (t.id === id ? { ...t, done: Math.round((file.size * i) / 4), state: i === 4 ? "saved" : "uploading" } : t)) });
    }
    return { ok: true, d: null };
  }
  dismissTransfer(id: string) {
    this.set({ transfers: this.snap.transfers.filter((t) => t.id !== id) });
  }
  async getFile(fid: string): Promise<File | null> {
    const f = this.snap.files.find((x) => x.fid === fid);
    return f ? new File(["demo"], f.name, { type: f.mime }) : null;
  }
  async removeFile(fid: string) {
    this.set({ files: this.snap.files.filter((f) => f.fid !== fid) });
  }
  dismissInbox(id: number) {
    this.set({ inbox: this.snap.inbox.filter((i) => i.id !== id) });
  }
  async forget() {
    this.set({ device: null, status: null, conn: "idle" });
  }
  async sendText(): Promise<Result> {
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true, d: null };
  }
  async command(op: Op, a?: Record<string, unknown>): Promise<Result> {
    await new Promise((r) => setTimeout(r, 150));
    const s = this.snap.status;
    if (op === "media.play_pause" && s?.media) this.status({ media: { ...s.media, playing: !s.media.playing } });
    if (op === "volume.set" && s?.volume) this.status({ volume: { ...s.volume, level: Number(a?.v) } });
    if (op === "volume.mute" && s?.volume) this.status({ volume: { ...s.volume, muted: !s.volume.muted } });
    if (op === "pc.lock" && s) this.status({ locked: true });
    if (op === "agent.answer" && s?.asks) this.status({ asks: s.asks.filter((x) => x.id !== a?.id) });
    return { ok: true, d: null };
  }
}
