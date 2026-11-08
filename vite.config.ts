import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// One build config for the relay (design 2.2): Nectar embeds the same file.
const relay = JSON.parse(readFileSync(new URL("./relay.config.json", import.meta.url), "utf8")) as { ref: string; pwaUrl: string };
if (!/^[a-z0-9]{20}$/.test(relay.ref)) throw new Error("relay.config.json: bad ref");
const base = new URL(relay.pwaUrl).pathname;

// Strict CSP generated from the relay ref (design section 10). `frame-ancestors` cannot be
// set from a meta tag; GitHub Pages sends no CSP header of its own.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  `connect-src https://${relay.ref}.supabase.co wss://${relay.ref}.supabase.co`,
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function securityHeaders(): Plugin {
  return {
    name: "nectar-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      // Right after the charset, before any script or stylesheet.
      handler: (html) =>
        html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer" content="no-referrer" />`,
        ),
    },
  };
}

/**
 * Offline-only service worker: precaches the built files so the PWA opens without a network.
 * It never touches relay traffic, and it is not a security boundary (design section 12).
 */
function serviceWorker(): Plugin {
  return {
    name: "nectar-sw",
    apply: "build",
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
      const all = ["./", ...files.map((f) => "./" + f), "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon.svg"];
      const hash = createHash("sha256").update(JSON.stringify(all));
      for (const b of Object.values(bundle)) hash.update(b.type === "chunk" ? b.code : b.source);
      const version = hash.digest("hex").slice(0, 16);
      const source = readFileSync(new URL("./src/sw.js", import.meta.url), "utf8").replace("__VERSION__", version).replace("__FILES__", JSON.stringify(all));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), securityHeaders(), serviceWorker()],
  // React's API on Preact: the same components at a fraction of the bytes on a phone network.
  resolve: {
    alias: [
      { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react(-dom)?$/, replacement: "preact/compat" },
    ],
  },
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: { port: 1430, strictPort: true },
});
