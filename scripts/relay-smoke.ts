// Checks the PWA's relay client against the real Supabase relay without needing a paired PC:
// anonymous sign-up and refresh, a private join that must be refused, and `link_rejoin` on a
// topic that does not exist (the phone's "removed on the PC" signal). Creates one anonymous
// user, which the relay's sweep deletes after 24 h.
//   bun scripts/relay-smoke.ts

import config from "../relay.config.json";
import { hex, randomBytes } from "../src/core/bytes";
import { rejoinMac } from "../src/core/crypto";
import { bytea, JoinError, Realtime, RelayError, Rest } from "../src/core/relay";

const rest = new Rest(config);
const now = () => Math.floor(Date.now() / 1000);
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

const auth = await rest.signupAnonymous(now());
check(/^[0-9a-f-]{36}$/.test(auth.userId), `anonymous sign-up (${auth.userId})`);
const refreshed = await rest.refresh(auth.refreshToken, now());
check(refreshed.userId === auth.userId && refreshed.refreshToken !== auth.refreshToken, "refresh rotates the token, same user");
const rt = new Realtime(config);
const topic = "nl-" + hex(randomBytes(16));
try {
  await rt.join(topic, refreshed.accessToken);
  check(false, "join on a topic we are not a member of is refused");
} catch (e) {
  check(e instanceof JoinError && e.kind === "unauthorized", `join refused as unauthorized (${(e as Error).message.slice(0, 120)})`);
}
rt.close();

const ts = now();
try {
  await rest.rpc(refreshed.accessToken, "link_rejoin", { t: topic, ts, mac: bytea(rejoinMac(randomBytes(32), topic, refreshed.userId, ts)) });
  check(false, "rejoin on a missing topic fails");
} catch (e) {
  check(e instanceof RelayError && e.kind === "status" && /bad mac/.test(e.message), `rejoin on a missing topic says bad mac (${(e as Error).message})`);
}
process.exit();
