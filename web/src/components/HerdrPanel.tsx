import { useCallback, useEffect, useState } from "react";
import {
  fetchFleet,
  fetchHerdrHost,
  runHostAction,
  updateConsole,
  rollbackConsole,
  type Fleet,
  type HerdrHost,
} from "@/lib/herdr";

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
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; command: string; output: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    // Asked together and independently: a daemon that is down must not hide the
    // fleet, which is what an operator is looking at when it is down.
    const [hostResult, fleetResult] = await Promise.all([
      fetchHerdrHost().catch(() => null),
      fetchFleet().catch(() => null),
    ]);
    setHost(hostResult);
    setFleet(fleetResult);
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

  async function actRollback(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const done = await rollbackConsole();
      if (done === null || !done.ok) {
        setResult({ ok: false, command: "roll back console", output: done?.error ?? "no previous build to go back to" });
      } else {
        setResult({
          ok: true,
          command: "roll back console",
          output: `previous build restored\nrestart to run it: ${done.restart ?? "restart the console"}`,
        });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function actConsole(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const done = await updateConsole();
      if (done === null) {
        setResult({ ok: false, command: "update console", output: "the request did not reach the bridge" });
      } else if (!done.ok) {
        setResult({
          ok: false,
          command: "update console",
          output: [done.error ?? "the update failed", ...done.steps.map((step) => `${step.step}: ${step.detail}`)].join("\n"),
        });
      } else {
        setResult({
          ok: true,
          command: "update console",
          output: [
            ...done.steps.map((step) => `${step.step}: ${step.detail}`),
            done.updated
              ? `restart to run the new build: ${done.restart ?? "restart the console"}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function act(action: "install" | "update" | "restart"): Promise<void> {
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
        {fleet !== null && (
          <section className="hostpanel__fleet" aria-label="Fleet">
            <div className="hostpanel__fleet-head">
              <span>{fleet.hub ? "fleet · this console is the hub" : "fleet"}</span>
              <span className="hostpanel__dim">
                {fleet.follow ? "follows newer builds" : "does not follow"}
              </span>
            </div>
            <ul id="herdr-fleet-list" className="hostpanel__fleet-list">
              {fleet.peers.length === 0 ? (
                <li className="hostpanel__dim">
                  {fleet.hub ? "no console has said hello yet" : "the hub lists no peers"}
                </li>
              ) : (
                fleet.peers.map((peer) => (
                  <li key={peer.id} data-peer={peer.id}>
                    <span className="hostpanel__fleet-addr">{peer.addr || peer.id}</span>
                    <span className="hostpanel__dim">{peer.version || "unknown"}</span>
                    {peer.stale && <span className="hostpanel__warn">stale</span>}
                  </li>
                ))
              )}
            </ul>
          </section>
        )}

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
            {host.installed && !host.serverRunning && (
              // An update stops an old server on purpose rather than killing the
              // sessions in it, so a stopped daemon is a step, not a fault: say
              // what to run next instead of leaving it at "not running".
              <div className="hostpanel__note" id="herdr-daemon-hint">
                <p>
                  no daemon is running here. herdr runs its own server headless — no terminal and
                  no multiplexer underneath it:
                </p>
                <pre className="hostpanel__output">herdr server</pre>
                <p>
                  the installer registers that as a service (<code>--herdr-service</code>) so it
                  starts at boot; the buttons above start it too.
                </p>
              </div>
            )}
            {host.serverRunning && (host.restartNeeded || host.serverBinaryStale) && (
              <p className="hostpanel__note" id="herdr-restart-hint">
                the running server is still on an older build. Stop it with <code>herdr server
                stop</code> (that ends its panes) and start herdr again to pick up this build.
              </p>
            )}
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
                    if (
                      window.confirm(
                        "Update herdr on this host now?\n\n" +
                          "The daemon is stopped first (that ends its panes), then updated, " +
                          "then started again so this console can reconnect.",
                      )
                    ) {
                      void act("update");
                    }
                  }}
                >
                  {host.updateAvailable ? `update to ${host.latestVersion}` : "update"}
                </button>
              )}
              <button
                type="button"
                id="herdr-console-update"
                className="hostpanel__act"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Update this console from its release source?\n\n" +
                        "The new binary replaces the running one; it starts on the next restart.",
                    )
                  ) {
                    void actConsole();
                  }
                }}
              >
                update console
              </button>
              <button
                type="button"
                id="herdr-console-rollback"
                className="hostpanel__act"
                title="put back the build this console replaced"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Put back the previous build of this console?\n\n" +
                        "Use it when an update starts but does not behave; it starts on the next restart.",
                    )
                  ) {
                    void actRollback();
                  }
                }}
              >
                roll back
              </button>
              {host.installed && (
                <button
                  type="button"
                  id="herdr-host-restart"
                  className="hostpanel__act"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Restart the herdr daemon on this host?\n\n" +
                          "Its panes end with it; the console reconnects when it answers.",
                      )
                    ) {
                      void act("restart");
                    }
                  }}
                >
                  restart daemon
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
