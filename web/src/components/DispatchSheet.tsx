import { useEffect, useState } from "react";
import {
  dispatchFailure,
  dispatchJob,
  fetchAgentKinds,
  fetchDispatches,
  retryDispatch,
  stopDispatchJob,
  type Dispatch,
  type DispatchedJob,
  type Fleet,
  type FleetPeer,
} from "@/lib/herdr";
import { collectCommand } from "@/lib/fleet";

/** A peer at its operator-set concurrency cap. */
function isFull(peer: FleetPeer): boolean {
  return (peer.maxTasks ?? 0) > 0 && (peer.running ?? 0) >= (peer.maxTasks ?? 0);
}

/**
 * A state the operator has to do something about. Working and done are not
 * warnings: colouring every state that has a name makes none of them stand out.
 */
function wantsLook(job: DispatchedJob): boolean {
  return (
    job.lost === true ||
    job.cancelled === true ||
    job.status === "stopped" ||
    job.status === "blocked" ||
    (job.error !== undefined && job.error !== "")
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  fleet: Fleet | null;
};

/**
 * One prompt, several machines.
 *
 * The point of a fleet is that the same task can run where it fits — a machine
 * with a domestic model, one with an overseas model, one that is simply idle —
 * and the results come back side by side instead of one at a time.
 */
export function DispatchSheet({ open, onClose, fleet }: Props) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [branch, setBranch] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [kind, setKind] = useState("");
  const [strategy, setStrategy] = useState<"fanout" | "single">("fanout");
  const [weight, setWeight] = useState<"light" | "standard" | "heavy">("standard");
  const [chosen, setChosen] = useState<string[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  /** Re-read the board; a failed read keeps what is already on screen. */
  function refreshBoard(): void {
    void fetchDispatches().then((next) => {
      if (next !== null) {
        setDispatches(next);
      }
    });
  }

  // This console is a target as well. Without it, a one-machine fleet has an
  // empty "machines" list and cannot send a task at all. A hub also reports
  // this console among the peers, so the machine can arrive twice — the self
  // entry carries its live capacity, the peer copy does not — and the list
  // must not offer the same target as two rows.
  const peers =
    fleet === null
      ? []
      : [fleet.self, ...fleet.peers.filter((peer) => peer.addr !== fleet.self.addr)];

  useEffect(() => {
    if (!open) {
      return;
    }
    // The agents to choose from are the ones the fleet can start, not the ones
    // this machine happens to have: the hub of a fleet often runs no agent at all.
    void fetchAgentKinds().then((local) => {
      const fromFleet = (fleet?.peers ?? []).flatMap((peer) => peer.agents ?? []);
      const all = Array.from(new Set([...local, ...fromFleet])).sort();
      setKinds(all);
      setKind((current) => current || all[0] || "");
    });
    refreshBoard();
  }, [open]);

  useEffect(() => {
    if (!open || chosen.length > 0) {
      return;
    }
    // Everything that can run this agent, chosen by default: a job sent where the
    // agent is not installed can only fail, and which machine has which agent is
    // not the same everywhere.
    setChosen(
      peers
        .filter((peer) => (peer.agents ?? []).includes(kind) && !isFull(peer))
        .map((peer) => `http://${peer.addr}`),
    );
  }, [open, peers, chosen.length, kind]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // A fleet poll can turn a selected machine full. Drop it rather than send a
    // job the target will refuse at its capacity gate.
    setChosen((current) => {
      const next = current.filter((url) => {
        const peer = peers.find((candidate) => `http://${candidate.addr}` === url);
        return peer === undefined || !isFull(peer);
      });
      return next.length === current.length ? current : next;
    });
  }, [open, peers]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // One board request at a time: the bridge can take up to 30 s to ask every
    // machine, and a 5 s timer without this gate stacked requests behind it.
    let inFlight = false;
    let cancelled = false;
    const timer = setInterval(() => {
      // A hidden tab should not make every target run git/status for a board
      // nobody is looking at.
      if (document.visibilityState === "hidden" || inFlight) {
        return;
      }
      inFlight = true;
      void fetchDispatches()
        .then((next) => {
          if (!cancelled && next !== null) {
            setDispatches(next);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  async function retry(id: string): Promise<void> {
    setProblem("");
    const ok = await retryDispatch(id);
    if (!ok) {
      setProblem("no machine took the task this time");
    }
    // Either way the board has news: a new start, or each machine's new reason.
    refreshBoard();
  }

  async function stop(job: DispatchedJob): Promise<void> {
    if (!window.confirm(`Stop ${job.workspaceId} on ${job.host}? Its worktree is discarded.`)) {
      return;
    }
    setProblem("");
    const stopped = await stopDispatchJob(job.host, job.workspaceId);
    if (!stopped) {
      setProblem(`could not stop ${job.workspaceId} on ${job.host}`);
      return;
    }
    setDispatches((current) =>
      current.map((entry) => ({
        ...entry,
        jobs: entry.jobs.map((item) =>
          item.host === job.host && item.workspaceId === job.workspaceId
            ? { ...item, status: "stopped", cancelled: true, error: "" }
            : item,
        ),
      })),
    );
  }

  async function send(): Promise<void> {
    setBusy(true);
    setProblem("");
    try {
      const done = await dispatchJob({
        prompt,
        cwd: cwd.trim() === "" ? undefined : cwd.trim(),
        branch: branch.trim() === "" ? undefined : branch.trim(),
        kind,
        strategy,
        weight,
        targets: chosen,
      });
      if (done === null) {
        setProblem("the request did not reach the bridge");
        return;
      }
      if ("error" in done) {
        setProblem(done.error);
        return;
      }
      const sent: Dispatch | undefined = done.dispatch ?? undefined;
      if (sent !== undefined) {
        setDispatches((current) => [sent, ...current]);
      }
      if (!done.ok) {
        // Nothing runs: keep the prompt so it can be sent again, not retyped.
        setProblem(dispatchFailure(done.dispatch));
        return;
      }
      setPrompt("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet sheet--fleet" role="dialog" aria-label="Dispatch a job" aria-modal="true">
      <div className="sheet__panel">
      <div className="sheet__head">
        <span className="sheet__title">fleet</span>
        <button type="button" id="dispatch-close" className="sheet__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="sheet__body">
        <div className="dispatch__form">
        <label className="newws__field">
          <span>prompt</span>
          <textarea
            id="dispatch-prompt"
            rows={4}
            value={prompt}
            spellCheck={false}
            placeholder="what should the agents do?"
            autoFocus
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label className="newws__field">
          <span>repository (a worktree per machine)</span>
          <input
            id="dispatch-cwd"
            value={cwd}
            spellCheck={false}
            placeholder="optional — /path/to/repo"
            onChange={(event) => setCwd(event.target.value)}
          />
        </label>
        <label className="newws__field">
          <span>branch</span>
          <input
            id="dispatch-branch"
            value={branch}
            spellCheck={false}
            placeholder="optional — job/name"
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        <label className="newws__field">
          <span>agent</span>
          <select id="dispatch-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            {kinds.length === 0 ? <option value="">none installed here</option> : null}
            {kinds.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="newws__field">
          <span>weight</span>
          <select
            id="dispatch-weight"
            value={weight}
            onChange={(event) => setWeight(event.target.value as "light" | "standard" | "heavy")}
          >
            <option value="light">light — edits, no build</option>
            <option value="standard">standard</option>
            <option value="heavy">heavy — build/tests, 2+ CPUs</option>
          </select>
          <span className="newws__dim">
            a placement hint; the target also checks free memory
          </span>
        </label>

        <div className="newws__field">
          <span>strategy</span>
          <div className="dispatch__strategy" role="group" aria-label="Dispatch strategy">
            <button
              type="button"
              id="dispatch-strategy-fanout"
              aria-pressed={strategy === "fanout"}
              onClick={() => setStrategy("fanout")}
            >
              every machine
            </button>
            <button
              type="button"
              id="dispatch-strategy-single"
              aria-pressed={strategy === "single"}
              onClick={() => setStrategy("single")}
            >
              one machine
            </button>
          </div>
          <span className="newws__dim">
            {strategy === "single"
              ? "offered to all selected; the freest one runs it"
              : "the same prompt runs independently on every selected machine"}
          </span>
        </div>

        <div className="newws__head">machines</div>
        <ul className="dispatch__targets">
          {peers.length === 0 ? (
            <li className="newws__note">no console is known yet</li>
          ) : (
            peers.map((peer) => {
              const url = `http://${peer.addr}`;
              const on = chosen.includes(url);
              // A console too old to report its own address still belongs in
              // the list; an unnamed row reads like a bug.
              const label = peer.addr === "" ? "this console" : peer.addr;
              const agents = peer.agents ?? [];
              // Only a machine that reported the agent is offered. An older
              // console with no agents field is unknown, not "can run anything".
              const capable = agents.includes(kind);
              const full = isFull(peer);
              const usable = capable && !full;
              const capacity = (peer.maxTasks ?? 0) > 0 ? `${peer.running ?? 0}/${peer.maxTasks}` : "";
              const models = peer.models ?? [];
              const tools = peer.tools ?? [];
              const hardware = [
                peer.cpus !== undefined && peer.cpus > 0 ? `${peer.cpus}c` : "",
                peer.memAvailableMB !== undefined && peer.memAvailableMB > 0
                  ? `${Math.round((peer.memAvailableMB / 1024) * 10) / 10}G free`
                  : "",
              ]
                .filter((part) => part !== "")
                .join(" ");
              // A box the operator cannot tick has to say why before the row is
              // cut off, and the reason is the first thing in the detail. Load
              // follows: how busy a machine is decides whether to send to it,
              // and the agent list comes last.
              const detail = [
                capable || kind === "" ? "" : `no ${kind}`,
                capacity,
                hardware,
                models.join(" "),
                agents.length === 0 ? "no agent reported" : agents.join(" "),
              ]
                .filter((part) => part !== "")
                .join(" · ");
              const tooltip = [
                capable ? "" : `${label} has no ${kind}`,
                full ? `${label} is at capacity` : "",
                tools.length > 0 ? `tools: ${tools.join(" ")}` : "",
                detail,
              ]
                .filter((part) => part !== "")
                .join(" — ");
              return (
                <li key={peer.id}>
                  <label
                    title={tooltip}
                    // Not a target: no box to tick reads as a missing control
                    // unless the whole row says it is unavailable.
                    data-unavailable={usable ? undefined : "true"}
                  >
                    <input
                      type="checkbox"
                      data-target={peer.addr}
                      checked={on}
                      disabled={!usable}
                      onChange={() =>
                        setChosen(on ? chosen.filter((item) => item !== url) : [...chosen, url])
                      }
                    />
                    <span>{label}</span>
                    <span className="newws__dim">{detail}</span>
                  </label>
                </li>
              );
            })
          )}
        </ul>

        <button
          type="button"
          id="dispatch-send"
          className="newws__submit"
          disabled={busy || prompt.trim() === "" || kind === ""}
          onClick={() => void send()}
        >
          {`${strategy === "single" ? "offer to" : "send to"} ${chosen.length} machine${chosen.length === 1 ? "" : "s"}`}
        </button>
        {problem !== "" && (
          <p className="newws__note newws__note--bad" role="status">
            {problem}
          </p>
        )}
        </div>

        <div className="dispatch__board">
          <section className="dispatch__results" aria-label="Dispatches">
            <div className="newws__head">task board</div>
            {dispatches.length === 0 && (
              <p className="newws__note">no tasks yet — send one from the form.</p>
            )}
            {dispatches.map((entry) => (
              <article key={entry.id} className="dispatch__entry" data-dispatch={entry.id}>
                <header>
                  <span>{entry.id}</span>
                  {entry.weight !== undefined && <span className="newws__dim">{entry.weight}</span>}
                  {entry.strategy === "single" &&
                    entry.jobs.every((job) => (job.workspaceId ?? "") === "" && job.cancelled !== true) && (
                      <button type="button" className="dispatch__retry" onClick={() => void retry(entry.id)}>
                        retry offer
                      </button>
                    )}
                </header>
                <p className="dispatch__prompt" title={entry.prompt}>
                  {entry.prompt}
                </p>
                <ul>
                  {entry.jobs.map((job) => (
                    <li key={job.host} data-host={job.host}>
                      {/* The machine and its state on one line: the state is what
                          the machine is doing, not a separate fact about it. */}
                      <div className="dispatch__line">
                        <span className="dispatch__host">{job.host}</span>
                        <span className="dispatch__status" data-status={wantsLook(job) ? "bad" : ""}>
                          {job.lost === true
                            ? `lost — check ${job.host}`
                            : job.cancelled === true || job.status === "stopped"
                              ? "stopped"
                              : job.error !== undefined && job.error !== ""
                              ? job.error
                              : job.status === "blocked"
                                ? "blocked — wants you"
                                : (job.status ?? "starting")}
                        </span>
                        {job.workspaceId !== "" && job.cancelled !== true && (
                          <button type="button" className="dispatch__stop" onClick={() => void stop(job)}>
                            stop
                          </button>
                        )}
                      </div>
                      {job.branch !== undefined && job.branch !== "" && (
                        <span className="newws__dim">{job.branch}</span>
                      )}
                      {job.cancelled !== true && job.diffReady === true && (job.commits ?? []).length === 0 && (
                        <span className="newws__dim">no commits</span>
                      )}
                      {(job.commits ?? []).length > 0 && (
                        <details open>
                          <summary>
                            {job.commits!.length} commit{job.commits!.length === 1 ? "" : "s"}
                            {job.branch !== undefined && job.branch !== "" ? ` on ${job.branch}` : ""}
                          </summary>
                          <ul className="dispatch__commits">
                            {job.commits!.map((commit) => (
                              <li key={commit}>{commit}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {(job.changed ?? []).length > 0 && (
                        <details>
                          <summary>{job.changed!.length} uncommitted</summary>
                          <ul className="dispatch__commits">
                            {job.changed!.map((file) => (
                              <li key={file}>{file}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {job.cancelled !== true && job.diffReady === true && (job.checkoutPath ?? "") !== "" && (
                        <details className="dispatch__collect">
                          <summary>collect</summary>
                          <code>{collectCommand(job.host, job.checkoutPath ?? "", job.branch ?? "")}</code>
                        </details>
                      )}
                      {job.output !== undefined && job.output.trim() !== "" && (
                        <details>
                          <summary>output</summary>
                          <pre>{job.output}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        </div>
      </div>
      </div>
    </div>
  );
}
