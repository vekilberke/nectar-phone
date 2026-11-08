import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Checks the production build output (run `bun run build` first; skipped when dist/ is missing).
const dist = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const built = existsSync(join(dist, "index.html"));
const t = built ? test : test.skip;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

t("index.html carries the strict CSP, no third-party origin and no inline script", () => {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(/<script(?![^>]*\ssrc=)[^>]*>/.test(html)).toBe(false);
  const origins = new Set([...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]));
  expect([...origins]).toEqual([]);
});

t("the service worker precaches exactly the emitted files and never the relay", () => {
  const sw = readFileSync(join(dist, "sw.js"), "utf8");
  const files: string[] = JSON.parse(/const FILES = (\[.*\]);/.exec(sw)![1]);
  const emitted = walk(dist).map((p) => p.slice(dist.length).split(String.fromCharCode(92)).join("/"));
  for (const f of files) {
    const rel = f.replace(/^\.\//, "").replace(/^\/[^/]+\//, "");
    expect(emitted.includes(rel) || f === "./" || f === "").toBe(true);
  }
  expect(sw).not.toContain("supabase");
  expect(sw).not.toContain("__FILES__");
  expect(sw).not.toContain("__VERSION__");
});

t("no demo code and no service-role key ship in the production bundle", () => {
  for (const p of walk(dist).filter((f) => /\.(js|html|css)$/.test(f))) {
    const s = readFileSync(p, "utf8");
    expect(s).not.toContain("?demo=");
    expect(s).not.toMatch(/service_role/);
  }
});
