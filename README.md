# Nectar Remote (phone PWA)

The phone side of Nectar's phone link: pair with the PC by scanning its QR code, then control media, volume and lock, answer Claude Code permission requests, and send text, links or the phone's clipboard to the PC. Everything is end-to-end encrypted; the Supabase relay only sees ciphertext. Design: `docs/phone-link-design.md` in the Nectar repository.

- `relay.config.json` is the one build config (relay ref, public key, PWA address). Nectar embeds the same file.
- `test-vectors.json` is written by the Rust tests; `tests/vectors.test.ts` checks the PWA reproduces every value.
- `src/core/` is the protocol (no DOM): crypto, pairing, session and ratchet, relay client, link controller.
- `src/ui/` is the interface (Preact through the React API), `src/sw.js` the offline-only service worker.

```bash
bun install --frozen-lockfile
bun test tests          # protocol tests
bun run build           # dist/, with the CSP generated from relay.config.json
bun run build:demo      # dist-demo/: canned screens (?demo=remote, ask, send, pairing, ...) for audits
bun scripts/sim-phone.ts --relay "<qr url>"   # simulated phone (used by the Rust interop tests)
```

`.github/workflows/pages.yml` builds and deploys to GitHub Pages when this folder is the root of its own repository.
