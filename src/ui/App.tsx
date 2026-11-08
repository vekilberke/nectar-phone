import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LinkApi as Link, Snapshot } from "../core/link";
import { parseQr, type Qr, type QrError } from "../core/protocol";
import { t } from "./i18n";
import { Pairing } from "./Pairing";
import { Remote } from "./Remote";

const LOCK = "nectar-link-session";

type LockState = "pending" | "held" | "busy";

/**
 * One tab per phone holds the session (design 6.1). Returns the lock state and a way to take
 * the lock from another tab; losing it stops the link.
 */
function useSessionLock(link: Link, onHeld: () => void): [LockState, () => void] {
  const [state, setState] = useState<LockState>("pending");
  const started = useRef(false);
  const onHeldRef = useRef(onHeld);
  onHeldRef.current = onHeld;

  const acquire = (steal: boolean) => {
    const locks = navigator.locks;
    if (!locks) {
      setState("held");
      onHeldRef.current();
      return;
    }
    const options: LockOptions = steal ? { steal: true } : { ifAvailable: true };
    locks
      .request(LOCK, options, (lock) => {
        if (!lock) {
          setState("busy");
          return undefined;
        }
        setState("held");
        onHeldRef.current();
        return new Promise<void>(() => {});
      })
      .catch(() => {
        // Another tab took the lock with `steal`.
        link.stop();
        setState("busy");
      });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    acquire(false);
  }, []);

  return [state, () => acquire(true)];
}

export function App({ link, hash, relayRef }: { link: Link; hash: string; relayRef: string }) {
  const snap: Snapshot = useSyncExternalStore(link.subscribe, link.snapshot);
  const [qrError, setQrError] = useState<QrError | null>(null);
  const [replace, setReplace] = useState<Qr | null>(null);
  const pendingHash = useRef(hash);

  const [lock, steal] = useSessionLock(link, () => {
    // Every time: after taking the lock back, start() reloads the keys another tab may have ratcheted.
    void link.start().then(() => {
      const h = pendingHash.current;
      pendingHash.current = "";
      if (!h) return;
      const qr = parseQr(h, relayRef, Math.floor(Date.now() / 1000));
      if (typeof qr === "string") setQrError(qr);
      else if (link.snapshot().device) setReplace(qr);
      else void link.pair(qr);
    });
  });

  if (lock === "pending") return <main className="app" aria-busy="true" />;

  if (lock === "busy") {
    return (
      <main className="app center">
        <section className="intro">
          <h1>{t("busy.title")}</h1>
          <p>{t("busy.body")}</p>
          <button className="btn primary" onClick={steal}>
            {t("busy.use")}
          </button>
        </section>
      </main>
    );
  }

  if (snap.pairing) {
    return <Pairing view={snap.pairing} onCancel={() => link.cancelPairing()} onDone={() => link.clearPairingView()} />;
  }

  if (replace && snap.device) {
    const vars = { old: snap.device.pcName, pc: replace.pcName };
    return (
      <main className="app center">
        <section className="intro">
          <h1>{t("pair.replaceTitle", vars)}</h1>
          <p>{t("pair.replaceBody", vars)}</p>
          <div className="row">
            <button className="btn" onClick={() => setReplace(null)}>
              {t("pair.cancel")}
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setReplace(null);
                void link.pair(replace);
              }}
            >
              {t("pair.replace", vars)}
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (!snap.device) {
    return (
      <main className="app center">
        <section className="intro">
          <span className="notch-mark" aria-hidden="true" />
          <h1>{t("unpaired.title")}</h1>
          {qrError && (
            <p className="alert" role="alert">
              {t(`pair.err.${qrError}`)}
            </p>
          )}
          <p>{t("unpaired.body")}</p>
          <p className="faint">{t("unpaired.privacy")}</p>
        </section>
      </main>
    );
  }

  return <Remote link={link} snap={snap} />;
}
