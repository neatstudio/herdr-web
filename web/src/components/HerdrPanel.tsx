import { useCallback, useEffect, useState } from "react";
import { fetchHerdrHost, runHostAction, type HerdrHost } from "@/lib/herdr";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The console's own build, so a second copy on another host is tellable apart. */
  consoleVersion: string;
};

/**
 * The state of herdr on this machine, and the two things you might do about it:
 * install it when it is missing, update it when a newer release exists. Both run
 * one fixed command on the host, so this panel never builds a command from what
 * is typed here.
 */
export function HerdrPanel({ open, onClose, consoleVersion }: Props) {
  const [host, setHost] = useState<HerdrHost | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; command: string; output: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setHost(await fetchHerdrHost());
  }, []);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  async function act(action: "install" | "update"): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const done = await runHostAction(action);
      if (done === null) {
        setResult({ ok: false, command: action, output: "the request did not reach the bridge" });
      } else {
        setResult({ ok: done.ok, command: done.command, output: done.output });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hostpanel" role="dialog" aria-modal="true" aria-label="herdr status">
      <header className="hostpanel__head">
        <span className="hostpanel__title">herdr</span>
        <button
          type="button"
          id="herdr-host-refresh"
          className="hostpanel__button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          re-check
        </button>
        <button type="button" id="herdr-host-close" className="hostpanel__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="hostpanel__body">
        {host === null ? (
          <p className="hostpanel__note">asking this machine…</p>
        ) : (
          <>
            <dl className="hostpanel__facts">
              <dt>this console</dt>
              <dd id="herdr-console-version">{consoleVersion || "unknown"}</dd>
              <dt>installed</dt>
              <dd id="herdr-host-installed">
                {host.installed ? host.binary : "no — herdr is not on this host"}
              </dd>
              {host.installed && (
                <>
                  <dt>version</dt>
                  <dd>
                    {host.clientVersion || "unknown"}
                    {host.channel !== "" && <span className="hostpanel__dim"> · {host.channel}</span>}
                    {host.latestVersion !== "" ? (
                      <span className="hostpanel__dim"> · latest {host.latestVersion}</span>
                    ) : (
                      <span className="hostpanel__dim"> · latest unknown</span>
                    )}
                  </dd>
                  <dt>daemon</dt>
                  <dd>
                    {host.serverRunning ? `running · ${host.serverVersion}` : "not running"}
                    {host.restartNeeded && <span className="hostpanel__warn"> · restart needed</span>}
                    {host.serverBinaryStale && <span className="hostpanel__warn"> · binary stale</span>}
                  </dd>
                  <dt>socket</dt>
                  <dd className="hostpanel__mono">{host.socket}</dd>
                  <dt>installed by</dt>
                  <dd>{host.installMethod}</dd>
                </>
              )}
            </dl>

            {host.error !== "" && <p className="hostpanel__note hostpanel__note--bad">{host.error}</p>}
            {host.installed && host.latestVersion === "" && (
              // No network is a normal state for a machine behind a private
              // link: say what still works instead of leaving a silent gap.
              <p className="hostpanel__note">
                the release feed could not be read, so an update cannot be checked here. The
                version above and the daemon state come from this machine and are still good.
              </p>
            )}

            <div className="hostpanel__actions">
              {!host.installed && (
                <button
                  type="button"
                  id="herdr-host-install"
                  className="hostpanel__act"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Install herdr on this host with the official installer?")) {
                      void act("install");
                    }
                  }}
                >
                  install herdr
                </button>
              )}
              {host.installed && host.canUpdate && (
                <button
                  type="button"
                  id="herdr-host-update"
                  className="hostpanel__act"
                  disabled={busy}
                  data-available={host.updateAvailable ? "true" : undefined}
                  onClick={() => {
                    if (window.confirm("Update herdr on this host now?")) {
                      void act("update");
                    }
                  }}
                >
                  {host.updateAvailable ? `update to ${host.latestVersion}` : "update"}
                </button>
              )}
              {host.installed && !host.canUpdate && (
                <p className="hostpanel__note">
                  this copy came from {host.installMethod}; update it with that package manager.
                </p>
              )}
            </div>

            {busy && <p className="hostpanel__note">working… this can take a minute.</p>}
            {result !== null && (
              <div className="hostpanel__result" data-ok={result.ok ? "true" : "false"}>
                <div className="hostpanel__command">{result.command}</div>
                <pre id="herdr-host-output" className="hostpanel__output">
                  {result.output.trim() === "" ? "(no output)" : result.output.trim()}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
