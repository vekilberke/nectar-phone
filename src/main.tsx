import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import config from "../relay.config.json";
import { Link, type LinkApi } from "./core/link";
import { RelayBlobs, Realtime, Rest } from "./core/relay";
import { IdbStore } from "./storage/idb";
import { browserFiles } from "./storage/opfs";
import { App } from "./ui/App";
import { lang } from "./ui/i18n";
import "./ui/styles.css";

document.documentElement.lang = lang;

// The pairing secret lives in the fragment; take it out of the address bar and history at once.
const hash = location.hash;
if (hash) history.replaceState(null, "", location.pathname + location.search);

function deviceName(): string {
  const ua = navigator.userAgent;
  const model = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua)?.[1]?.trim();
  return model && model !== "K" ? model : /Android/.test(ua) ? "Android phone" : "Phone";
}

function shortUa(): string {
  const ua = navigator.userAgent;
  const os = /Android ([\d.]+)/.exec(ua)?.[1];
  const chrome = /Chrome\/(\d+)/.exec(ua)?.[1];
  return [os ? `Android ${os}` : "", chrome ? `Chrome ${chrome}` : ""].filter(Boolean).join(", ") || "Browser";
}

/** Chrome lets a focused, visible page write the clipboard without a tap; anything else is refused. */
async function writeClipboard(text: string): Promise<boolean> {
  if (document.visibilityState !== "visible" || !document.hasFocus() || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const real = () =>
  new Link({
    store: new IdbStore(),
    rest: new Rest(config),
    channel: () => new Realtime(config),
    identity: () => ({ name: deviceName(), ua: shortUa() }),
    onPaired: () => void navigator.storage?.persist?.().catch(() => {}),
    blobs: (token) => new RelayBlobs(config, token),
    files: browserFiles(),
    clipboard: { write: writeClipboard },
  });

// The demo build (VITE_DEMO=1) shows canned screens; production builds drop this branch.
const demo = import.meta.env.VITE_DEMO === "1" ? new URLSearchParams(location.search).get("demo") : null;
const link: LinkApi = demo ? new (await import("./demo")).DemoLink(demo) : real();

document.addEventListener("visibilitychange", () => link.setVisible(document.visibilityState === "visible"));
addEventListener("pagehide", () => link.leave());
addEventListener("pageshow", (e) => e.persisted && link.setVisible(document.visibilityState === "visible"));

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const register = () => void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  if (document.readyState === "complete") register();
  else addEventListener("load", register, { once: true });
}

// A meta CSP cannot set frame-ancestors and GitHub Pages sends no headers: refuse to run in a
// frame, so no page can overlay Allow / Lock buttons (clickjacking).
if (window.top !== window.self) {
  document.body.textContent = "Nectar Remote cannot run inside a frame.";
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App link={link} hash={hash} relayRef={config.ref} />
    </StrictMode>,
  );
}
