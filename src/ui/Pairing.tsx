import { useEffect, useState } from "react";
import type { PairingView } from "../core/link";
import { t } from "./i18n";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function Pairing({ view, onCancel, onDone }: { view: PairingView; onCancel: () => void; onDone: () => void }) {
  const now = useNow(view.step === "code");
  const pc = { pc: view.pcName };

  useEffect(() => {
    if (view.step !== "done") return;
    const id = setTimeout(onDone, 1400);
    return () => clearTimeout(id);
  }, [view.step, onDone]);

  const left = Math.max(0, view.expiresAt - Math.floor(now / 1000));
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

  return (
    <main className="app center">
      <section className="intro pairing" aria-live="polite">
        <span className="notch-mark" aria-hidden="true" data-state={view.step} />
        {view.step === "joining" && <h1>{t("pair.joining", pc)}</h1>}
        {view.step === "code" && view.code && (
          <>
            <h1>{t("pair.codeTitle", pc)}</h1>
            <p className="code" aria-label={view.code.split("").join(" ")}>
              <span>{view.code.slice(0, 3)}</span>
              <span>{view.code.slice(3)}</span>
            </p>
            <p>{t("pair.codeHint")}</p>
            {/* The ticking countdown is not announced; a screen reader hears it once, a minute before the end. */}
            <p className="faint tabular" aria-live="off">
              {t("pair.expires", { time })}
            </p>
            {left > 0 && left <= 60 && <p className="sr-only">{t("pair.expires", { time: "1:00" })}</p>}
          </>
        )}
        {view.step === "done" && <h1>{t("pair.done", pc)}</h1>}
        {view.step === "error" && (
          <>
            <h1>{t(`pair.err.${view.error ?? "network"}`)}</h1>
            <p>{t("pair.retry")}</p>
          </>
        )}
        {view.step !== "done" && (
          <button className="btn" onClick={onCancel}>
            {t("pair.cancel")}
          </button>
        )}
      </section>
    </main>
  );
}
