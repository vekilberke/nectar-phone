import { ArrowDownToLine, ArrowUpFromLine, Check, ClipboardPaste, Copy, Download, FileUp, Lock, Minus, Pause, Play, Plus, Settings, Share2, SkipBack, SkipForward, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LinkApi as Link, ReceivedFile, Result, Snapshot, TransferView } from "../core/link";
import { type Ask, askCardId, normalizeUrl, type Perms } from "../core/messages";
import { type Key, lang, t } from "./i18n";

type Note = { text: string; tone: "ok" | "err" } | null;

/** Runs a command and keeps a short result line for the block it belongs to. */
function useAction() {
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (text: string, tone: "ok" | "err") => {
    if (timer.current) clearTimeout(timer.current);
    setNote({ text, tone });
    timer.current = setTimeout(() => setNote(null), tone === "ok" ? 2500 : 6000);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const run = async (p: Promise<Result>, ok?: string): Promise<Result> => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (r.ok) {
      if (ok) show(ok, "ok");
    } else show(t(`err.${r.e}` as Key), "err");
    return r;
  };
  return { note, busy, run, show };
}

function NoteLine({ note }: { note: Note }) {
  return (
    <p className="note" role="status" data-tone={note?.tone} data-empty={note ? undefined : ""}>
      {note?.text ?? ""}
    </p>
  );
}

export function Remote({ link, snap }: { link: Link; snap: Snapshot }) {
  const device = snap.device!;
  const perms = device.perms;
  const pc = device.pcName;
  const online = snap.conn === "online";
  const status = snap.status;
  const settings = useRef<HTMLDialogElement>(null);

  return (
    <main className="app remote">
      <header className="top">
        <div className="notch" data-conn={snap.conn}>
          <span className="dot" aria-hidden="true" />
          <span className="notch-name">{pc}</span>
          <span className="notch-state">{t(`conn.${snap.conn}` as Key)}</span>
        </div>
        <button className="icon-btn" aria-label={t("settings.open")} onClick={() => settings.current?.showModal()}>
          <Settings size={20} aria-hidden="true" />
        </button>
      </header>

      <Banner link={link} snap={snap} />

      {/* Pending asks come before anything that can appear above them (design: no layout shift under Allow). */}
      {(perms.agentStatus || (perms.agentAsk && ((status?.asks?.length ?? 0) > 0 || (status?.asksMore ?? 0) > 0))) && (
        <fieldset className="stack" disabled={!online}>
          <Claude link={link} asks={status?.asks ?? []} more={status?.asksMore ?? 0} agent={status?.agent ?? null} perms={perms} />
        </fieldset>
      )}

      {snap.inbox.length > 0 && <Inbox link={link} snap={snap} />}

      {(snap.transfers.length > 0 || snap.files.length > 0) && <Transfers link={link} snap={snap} />}

      <fieldset className="stack" disabled={!online}>
        {perms.media && <Media link={link} media={status?.media ?? null} />}
        {perms.volume && <Volume link={link} volume={status?.volume ?? null} />}
      </fieldset>

      {/* Text and files also work while the PC is offline: they wait in its mailbox. */}
      {(perms.clipboard || perms.textIn || perms.filesIn || perms.openUrl === "on" || perms.openUrl === "ask") && (
        <fieldset className="stack" disabled={snap.conn === "revoked"}>
          <Send link={link} perms={perms} pc={pc} online={online} />
        </fieldset>
      )}

      {(perms.lock || perms.status) && (
        <fieldset className="stack" disabled={!online}>
          <Pc link={link} perms={perms} snap={snap} />
        </fieldset>
      )}

      <SettingsDialog sheetRef={settings} link={link} snap={snap} />
    </main>
  );
}

function Banner({ link, snap }: { link: Link; snap: Snapshot }) {
  const pc = { pc: snap.device!.pcName };
  switch (snap.conn) {
    case "waiting":
      return (
        <div className="banner" role="status">
          <p>{t("banner.waiting", pc)}</p>
          <button className="btn small" onClick={() => link.reconnect()}>
            {t("banner.retry")}
          </button>
        </div>
      );
    case "offline":
      return (
        <div className="banner" role="status">
          <p>{t("banner.offline")}</p>
          <button className="btn small" onClick={() => link.reconnect()}>
            {t("banner.retry")}
          </button>
        </div>
      );
    case "paused":
      return (
        <div className="banner" role="status">
          <p>{t("banner.paused")}</p>
        </div>
      );
    case "ended":
      return (
        <div className="banner" role="status">
          <p>{t("banner.ended", pc)}</p>
          <button className="btn small" onClick={() => link.reconnect()}>
            {t("banner.reconnect")}
          </button>
        </div>
      );
    case "revoked":
      return (
        <div className="banner danger" role="alert">
          <p>{t("banner.revoked", pc)}</p>
          <button className="btn small" onClick={() => void link.forget()}>
            {t("banner.forget")}
          </button>
        </div>
      );
    default:
      return null;
  }
}

const STATE_KEYS: Record<string, Key> = {
  working: "claude.state.working",
  tool: "claude.state.tool",
  needs_input: "claude.state.needs_input",
  done: "claude.state.done",
  error: "claude.state.error",
  idle: "claude.state.idle",
};

/** Taps on an ask's buttons count only this long after the card appeared or moved. */
const ARM_MS = 700;
/** A longer command starts folded, and Allow waits until it is shown in full. */
const FOLD_LINES = 8;
const FOLD_CHARS = 600;

type Sent = "sending" | "allow" | "deny";

function Claude({ link, asks, more, agent, perms }: { link: Link; asks: Ask[]; more: number; agent: { state: string; name: string; project: string } | null; perms: Perms }) {
  const [sent, setSent] = useState<Map<string, Sent>>(new Map());
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [, redraw] = useState(0);
  const { note, run } = useAction();
  const open = perms.agentAsk ? asks : [];
  const extra = perms.agentAsk ? more : 0;
  const cards = useRef(new Map<string, HTMLElement>());
  const placed = useRef(new Map<string, { top: number; at: number }>());
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A card that just appeared or moved (an ask above it went away, a banner or text arrived)
  // ignores taps for a moment, so a second tap never lands on a request the user has not read.
  const rearm = (id: string, top: number) => {
    placed.current.set(id, { top, at: performance.now() });
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => redraw((n) => n + 1), ARM_MS + 20);
  };
  const topOf = (el: HTMLElement) => el.getBoundingClientRect().top + window.scrollY;

  useLayoutEffect(() => {
    let moved = false;
    for (const [id, el] of cards.current) {
      const top = topOf(el);
      const p = placed.current.get(id);
      if (!p || Math.abs(p.top - top) > 1) {
        rearm(id, top);
        moved = true;
      }
    }
    for (const id of placed.current.keys()) if (!cards.current.has(id)) placed.current.delete(id);
    if (moved) redraw((n) => n + 1);
  });
  useEffect(() => () => void (armTimer.current && clearTimeout(armTimer.current)), []);

  const armed = (id: string) => {
    const p = placed.current.get(id);
    return !!p && performance.now() - p.at >= ARM_MS;
  };

  const answer = async (a: Ask, allow: boolean) => {
    const id = askCardId(a);
    const el = cards.current.get(id);
    if (!el || sent.has(id)) return;
    const top = topOf(el);
    if (Math.abs((placed.current.get(id)?.top ?? -1) - top) > 1) {
      rearm(id, top);
      redraw((n) => n + 1);
      return;
    }
    if (!armed(id)) return;
    // The card stays where it is until the PC drops the ask from its status.
    setSent((m) => new Map(m).set(id, "sending"));
    const r = await run(link.command("agent.answer", { id: a.id, key: a.key, allow }));
    setSent((m) => {
      const n = new Map(m);
      if (r.ok) n.set(id, allow ? "allow" : "deny");
      else n.delete(id);
      return n;
    });
  };

  const waiting = open.filter((a) => !sent.has(askCardId(a))).length + extra;
  const stateKey = agent ? STATE_KEYS[agent.state] : undefined;
  return (
    <section className="card claude" aria-labelledby="claude-h" data-waiting={waiting > 0}>
      <div className="card-head">
        <h2 id="claude-h">{t("claude.title")}</h2>
        <p className="meta">
          {waiting > 0
            ? t("claude.waiting", { n: waiting })
            : agent && stateKey
              ? [t(stateKey), agent.project].filter(Boolean).join(", ")
              : perms.agentStatus
                ? t("claude.none")
                : ""}
        </p>
      </div>
      {open.map((a) => {
        const id = askCardId(a);
        const dom = `ask-${a.id}-${a.key}`;
        const lines = a.detail ? a.detail.split("\n") : [];
        const long = lines.length > FOLD_LINES || a.detail.length > FOLD_CHARS;
        const folded = long && !unfolded.has(id);
        const shown = folded ? lines.slice(0, FOLD_LINES).join("\n").slice(0, FOLD_CHARS) : a.detail;
        const hiddenLines = folded ? lines.length - shown.split("\n").length : 0;
        const state = sent.get(id);
        const ready = !state && armed(id);
        const canAllow = ready && !folded && !a.truncated;
        return (
          <article
            className="ask"
            key={id}
            ref={(el) => void (el ? cards.current.set(id, el) : cards.current.delete(id))}
            aria-label={`${a.tool || a.name}${a.project ? `, ${a.project}` : ""}`}
            data-arming={!state && !armed(id) ? "" : undefined}
          >
            <p className="ask-tool">
              {a.tool || a.name || "Claude Code"}
              {a.project && <span className="meta"> {a.project}</span>}
            </p>
            {a.detail && (
              <code className="ask-detail" id={dom}>
                {shown}
                {folded && "…"}
              </code>
            )}
            {folded && (
              <button
                className="btn small"
                aria-controls={dom}
                aria-expanded="false"
                onClick={() => setUnfolded((u) => new Set(u).add(id))}
              >
                {hiddenLines > 0 ? t("claude.moreLines", { n: hiddenLines }) : t("claude.showAll")}
              </button>
            )}
            {a.truncated && <p className="meta ask-warn">{t("claude.truncated")}</p>}
            <div className="row">
              <button className="btn" disabled={!ready} onClick={() => void answer(a, false)}>
                {state === "deny" ? t("claude.denied") : state === "sending" ? t("claude.sending") : t("claude.deny")}
              </button>
              <button className="btn primary" disabled={!canAllow} onClick={() => void answer(a, true)}>
                {state === "allow" ? t("claude.allowed") : t("claude.allow")}
              </button>
            </div>
          </article>
        );
      })}
      {extra > 0 && <p className="meta">{t("claude.more", { n: extra })}</p>}
      <NoteLine note={note} />
    </section>
  );
}

function Inbox({ link, snap }: { link: Link; snap: Snapshot }) {
  const [copied, setCopied] = useState<number | null>(null);
  const copy = async (id: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      /* the text stays selectable */
    }
  };
  return (
    <section className="card" aria-labelledby="inbox-h">
      <div className="card-head">
        <h2 id="inbox-h">{t("inbox.title", { pc: snap.device!.pcName })}</h2>
      </div>
      <ul className="inbox">
        {snap.inbox.map((i) => (
          <li key={i.id}>
            <p className="inbox-text">{i.text}</p>
            <div className="row end">
              <button className="btn small" onClick={() => link.dismissInbox(i.id)}>
                <X size={16} aria-hidden="true" />
                {t("inbox.dismiss")}
              </button>
              <button className="btn small" onClick={() => void copy(i.id, i.text)}>
                {copied === i.id ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                {copied === i.id ? t("inbox.copied") : t("inbox.copy")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const mb = (n: number) => (n >= 10_000_000 ? (n / 1_000_000).toFixed(0) : n >= 100_000 ? (n / 1_000_000).toFixed(1) : (n / 1_000_000).toFixed(2));
const FINISHED = new Set(["saved", "queued", "ready", "failed"]);

function TransferRow({ x, pc, onDismiss }: { x: TransferView; pc: string; onDismiss: () => void }) {
  const pct = x.size > 0 ? Math.min(100, Math.round((x.done / x.size) * 100)) : x.state === "saved" || x.state === "ready" ? 100 : 0;
  const moving = x.state === "uploading" || x.state === "downloading" || x.state === "preparing";
  const Icon = x.dir === "p2c" ? ArrowUpFromLine : ArrowDownToLine;
  return (
    <li className="xfer" data-state={x.state}>
      <Icon size={18} aria-hidden="true" className="xfer-icon" />
      <div className="xfer-body">
        <p className="xfer-name" title={x.name}>
          {x.name}
        </p>
        <p className="meta tabular">
          {[t(x.dir === "p2c" ? "xfer.toPc" : "xfer.fromPc", { pc }), x.state === "failed" && x.e ? t(`err.${x.e}` as Key) : t(`xfer.state.${x.state}` as Key), moving ? `${mb(x.done)} / ${mb(x.size)} MB` : `${mb(x.size)} MB`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {!FINISHED.has(x.state) && (
          <div className="bar" role="progressbar" aria-label={x.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-busy={moving ? undefined : ""}>
            <span style={{ width: `${moving ? pct : 100}%` }} />
          </div>
        )}
      </div>
      {FINISHED.has(x.state) && (
        <button className="icon-btn" aria-label={`${t("xfer.dismiss")}: ${x.name}`} onClick={onDismiss}>
          <X size={18} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function FileRow({ link, f }: { link: Link; f: ReceivedFile }) {
  const { note, show } = useAction();
  const canShare = typeof navigator.canShare === "function";
  const save = async () => {
    const file = await link.getFile(f.fid);
    if (!file) return show(t("err.io"), "err");
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.rel = "noopener";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const share = async () => {
    const file = await link.getFile(f.fid);
    if (!file) return show(t("err.io"), "err");
    if (!navigator.canShare?.({ files: [file] })) return save();
    await navigator.share({ files: [file], title: file.name }).catch(() => {});
  };
  return (
    <li className="file">
      <div className="xfer-body">
        <p className="xfer-name" title={f.name}>
          {f.name}
        </p>
        <p className="meta tabular">{mb(f.size)} MB</p>
      </div>
      <div className="row">
        <button className="btn small" onClick={() => void save()}>
          <Download size={16} aria-hidden="true" />
          {t("files.save")}
        </button>
        {canShare && (
          <button className="btn small" onClick={() => void share()}>
            <Share2 size={16} aria-hidden="true" />
            {t("files.share")}
          </button>
        )}
        <button className="btn small icon-only" aria-label={`${t("files.remove")}: ${f.name}`} onClick={() => void link.removeFile(f.fid)}>
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
      <NoteLine note={note} />
    </li>
  );
}

function Transfers({ link, snap }: { link: Link; snap: Snapshot }) {
  const pc = snap.device!.pcName;
  return (
    <section className="card" aria-labelledby="xfer-h">
      {snap.files.length > 0 && (
        <>
          <div className="card-head">
            <h2 id="xfer-h">{t("files.title", { pc })}</h2>
          </div>
          <ul className="xfers">
            {snap.files.map((f) => (
              <FileRow key={f.fid} link={link} f={f} />
            ))}
          </ul>
          <p className="meta">{t("files.kept")}</p>
        </>
      )}
      {snap.transfers.length > 0 && (
        <>
          <div className="card-head">
            {snap.files.length > 0 ? <h3 className="label">{t("xfer.title")}</h3> : <h2 id="xfer-h">{t("xfer.title")}</h2>}
          </div>
          <ul className="xfers">
            {snap.transfers.map((x) => (
              <TransferRow key={x.id} x={x} pc={pc} onDismiss={() => link.dismissTransfer(x.id)} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Media({ link, media }: { link: Link; media: { playing: boolean; title?: string; artist?: string } | null }) {
  const { note, run } = useAction();
  const playing = media?.playing ?? false;
  const title = media?.title || (media ? t(playing ? "media.playing" : "media.paused") : t("media.nothing"));
  return (
    <section className="card" aria-labelledby="media-h">
      <h2 id="media-h" className="sr-only">
        {t("media.title")}
      </h2>
      <div className="track">
        <p className="track-title">{title}</p>
        {media?.artist && <p className="meta">{media.artist}</p>}
      </div>
      <div className="transport">
        <button className="round" aria-label={t("media.prev")} onClick={() => void run(link.command("media.previous"))}>
          <SkipBack size={22} aria-hidden="true" />
        </button>
        <button className="round big" aria-label={t(playing ? "media.pause" : "media.play")} onClick={() => void run(link.command("media.play_pause"))}>
          {playing ? <Pause size={28} aria-hidden="true" fill="currentColor" /> : <Play size={28} aria-hidden="true" fill="currentColor" />}
        </button>
        <button className="round" aria-label={t("media.next")} onClick={() => void run(link.command("media.next"))}>
          <SkipForward size={22} aria-hidden="true" />
        </button>
      </div>
      <NoteLine note={note} />
    </section>
  );
}

function Volume({ link, volume }: { link: Link; volume: { level: number; muted: boolean } | null }) {
  const { note, run } = useAction();
  const [local, setLocal] = useState<number | null>(null);
  const lastInput = useRef(0);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remote = Math.round((volume?.level ?? 0) * 100);
  const value = local ?? remote;
  const muted = volume?.muted ?? false;

  useEffect(
    () => () => {
      if (sendTimer.current) clearTimeout(sendTimer.current);
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

  const send = (v: number) => void run(link.command("volume.set", { v: v / 100 }));
  const onInput = (v: number) => {
    setLocal(v);
    const now = Date.now();
    if (sendTimer.current) clearTimeout(sendTimer.current);
    if (now - lastInput.current > 150) {
      lastInput.current = now;
      send(v);
    } else sendTimer.current = setTimeout(() => send(v), 150);
    // Keep the dragged value until the PC's status has caught up.
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => setLocal(null), 1500);
  };

  return (
    <section className="card" aria-labelledby="volume-h">
      <div className="card-head">
        <h2 id="volume-h">{t("volume.title")}</h2>
        <p className="meta tabular">{muted ? t("volume.muted") : `${value}%`}</p>
      </div>
      <div className="volume">
        <button className="round" aria-label={t("volume.down")} onClick={() => void run(link.command("volume.down"))}>
          <Minus size={20} aria-hidden="true" />
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          aria-labelledby="volume-h"
          aria-valuetext={`${value}%`}
          onChange={(e) => onInput(Number(e.currentTarget.value))}
        />
        <button className="round" aria-label={t("volume.up")} onClick={() => void run(link.command("volume.up"))}>
          <Plus size={20} aria-hidden="true" />
        </button>
        <button className="round" aria-label={t(muted ? "volume.unmute" : "volume.mute")} aria-pressed={muted} onClick={() => void run(link.command("volume.mute"))}>
          {muted ? <VolumeX size={20} aria-hidden="true" /> : <Volume2 size={20} aria-hidden="true" />}
        </button>
      </div>
      <NoteLine note={note} />
    </section>
  );
}

function Send({ link, perms, pc, online }: { link: Link; perms: Perms; pc: string; online: boolean }) {
  const { note, busy, run, show } = useAction();
  const [text, setText] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const sentNote = (r: Result) => {
    if (r.ok && (r.d as { queued?: boolean } | null)?.queued) show(t("send.queued", { pc }), "ok");
  };
  const sendFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (picker.current) picker.current.value = "";
    for (const file of files) {
      const r = await link.sendFile(file);
      if (!r.ok) show(t(`err.${r.e}` as Key), "err");
      else sentNote(r);
    }
  };
  const canUrl = perms.openUrl === "on" || perms.openUrl === "ask";
  const trimmed = text.trim();
  const url = canUrl && trimmed && !/\s/.test(trimmed) && /\.|:\/\//.test(trimmed) ? normalizeUrl(trimmed) : null;

  const sendClipboard = async () => {
    let clip: string;
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      show(t("send.blocked"), "err");
      return;
    }
    if (!clip) {
      show(t("send.empty"), "err");
      return;
    }
    if (perms.clipboard && online) await run(link.command("clipboard.set", { text: clip }), t("send.copied"));
    else sentNote(await run(link.sendText(clip), online ? t("send.sent", { pc }) : undefined));
  };

  const primary = async () => {
    if (!trimmed) return;
    const r = url && online ? await run(link.command("url.open", { u: url }), t("send.opened", { pc })) : await run(link.sendText(text), online ? t("send.sent", { pc }) : undefined);
    sentNote(r);
    if (r.ok) setText("");
  };

  return (
    <section className="card" aria-labelledby="send-h">
      <div className="card-head">
        <h2 id="send-h">{t("send.title")}</h2>
      </div>
      {!online && <p className="meta">{t("send.offlineHint", { pc })}</p>}
      {perms.filesIn && (
        <>
          <input ref={picker} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void sendFiles(e.currentTarget.files)} />
          <button className="btn wide" onClick={() => picker.current?.click()} aria-describedby="file-hint">
            <FileUp size={20} aria-hidden="true" />
            {t("send.file")}
          </button>
          <p id="file-hint" className="meta">
            {t("send.fileHint")}
          </p>
        </>
      )}
      {(perms.clipboard || perms.textIn) && (online || perms.textIn) && (
        <button className="btn wide" onClick={() => void sendClipboard()} disabled={busy} aria-describedby="clip-hint">
          <ClipboardPaste size={20} aria-hidden="true" />
          {t("send.clipboard")}
        </button>
      )}
      {(perms.clipboard || perms.textIn) && (
        <p id="clip-hint" className="meta">
          {perms.clipboard ? t("send.clipboardHint") : ""}
        </p>
      )}
      {(perms.textIn || canUrl || perms.clipboard) && (
        <form
          className="compose"
          onSubmit={(e) => {
            e.preventDefault();
            void primary();
          }}
        >
          <label htmlFor="compose-text" className="label">
            {t("send.label")}
          </label>
          <textarea id="compose-text" rows={3} value={text} maxLength={65536} onChange={(e) => setText(e.currentTarget.value)} autoCapitalize="sentences" enterKeyHint="send" />
          <div className="row">
            {perms.clipboard && (
              <button type="button" className="btn" disabled={!trimmed || busy || !online} onClick={() => void run(link.command("clipboard.set", { text }), t("send.copied"))}>
                {t("send.copy")}
              </button>
            )}
            {(perms.textIn || url) && (
              <button type="submit" className="btn primary" disabled={!trimmed || busy || (!online && (!perms.textIn || !!url))}>
                {url && online ? t("send.open") : t("send.text")}
              </button>
            )}
          </div>
        </form>
      )}
      <NoteLine note={note} />
    </section>
  );
}

function Pc({ link, perms, snap }: { link: Link; perms: Perms; snap: Snapshot }) {
  const { note, run } = useAction();
  const [confirm, setConfirm] = useState(false);
  const status = snap.status;
  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  const facts: string[] = [];
  if (status) {
    facts.push(t(status.locked ? "pc.locked" : "pc.unlocked"));
    facts.push(status.battery ? `${t("pc.battery", { n: Math.round(status.battery.percent) })}${status.battery.charging ? `, ${t("pc.charging")}` : ""}` : t("pc.noBattery"));
  }
  return (
    <section className="card pc" aria-labelledby="pc-h">
      <div className="card-head">
        <h2 id="pc-h">{snap.device!.pcName}</h2>
        <p className="meta">{facts.join(", ")}</p>
      </div>
      {perms.lock && (
        <button
          className={`btn wide${confirm ? " danger" : ""}`}
          onClick={() => {
            if (!confirm) setConfirm(true);
            else {
              setConfirm(false);
              void run(link.command("pc.lock"), t("pc.locked"));
            }
          }}
        >
          <Lock size={20} aria-hidden="true" />
          {confirm ? t("pc.lockConfirm") : t("pc.lock")}
        </button>
      )}
      <NoteLine note={note} />
    </section>
  );
}

const PERM_KEYS: (keyof Perms)[] = ["media", "volume", "lock", "status", "mediaInfo", "agentStatus", "agentAsk", "clipboard", "textIn", "textOut", "filesIn", "filesOut", "openUrl"];

function SettingsDialog({ sheetRef, link, snap }: { sheetRef: React.Ref<HTMLDialogElement>; link: Link; snap: Snapshot }) {
  const [confirm, setConfirm] = useState(false);
  const d = snap.device!;
  const date = new Date(d.pairedAt * 1000).toLocaleDateString(lang === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
  const allowed = PERM_KEYS.filter((k) => (k === "openUrl" ? d.perms.openUrl === "on" || d.perms.openUrl === "ask" : d.perms[k]));
  const close = (e: React.MouseEvent<HTMLElement>) => {
    setConfirm(false);
    (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close();
  };
  return (
    <dialog ref={sheetRef} className="sheet" aria-labelledby="settings-h" onClose={() => setConfirm(false)}>
      <div className="card-head">
        <h2 id="settings-h">{t("settings.title")}</h2>
        <button className="icon-btn" aria-label={t("settings.close")} onClick={close}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <p>{t("settings.pairedWith", { pc: d.pcName, date })}</p>
      <h3 className="label">{t("settings.allowed")}</h3>
      <ul className="perms">
        {allowed.map((k) => (
          <li key={k}>{t(`perm.${k}` as Key)}</li>
        ))}
      </ul>
      <p className="faint">{t("unpaired.privacy")}</p>
      {confirm ? (
        <>
          <p role="alert">{t("settings.forgetConfirm", { pc: d.pcName })}</p>
          <div className="row">
            <button className="btn" onClick={() => setConfirm(false)}>
              {t("pair.cancel")}
            </button>
            <button
              className="btn danger"
              onClick={(e) => {
                close(e);
                void link.forget();
              }}
            >
              {t("settings.forgetYes")}
            </button>
          </div>
        </>
      ) : (
        <button className="btn wide" onClick={() => setConfirm(true)}>
          {t("settings.forget")}
        </button>
      )}
    </dialog>
  );
}
