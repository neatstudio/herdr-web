import { useEffect, useState } from "react";
import {
  dispatchJob,
  fetchAgentKinds,
  fetchDispatches,
  type Dispatch,
  type Fleet,
} from "@/lib/herdr";

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
  const [chosen, setChosen] = useState<string[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const peers = fleet?.peers ?? [];

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
    void fetchDispatches().then(setDispatches);
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
        .filter((peer) => (peer.agents ?? []).includes(kind) || (peer.agents ?? []).length === 0)
        .map((peer) => `http://${peer.addr}`),
    );
  }, [open, peers, chosen.length, kind]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = setInterval(() => void fetchDispatches().then(setDispatches), 5000);
    return () => clearInterval(timer);
  }, [open]);

  if (!open) {
    return null;
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
      setDispatches([done.dispatch, ...dispatches]);
      setPrompt("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet sheet--dialog" role="dialog" aria-label="Dispatch a job" aria-modal="true">
      <div className="sheet__panel">
      <div className="sheet__head">
        <span className="sheet__title">send a job to the fleet</span>
        <button type="button" id="dispatch-close" className="sheet__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="sheet__body">
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

        <div className="newws__head">machines</div>
        <ul className="dispatch__targets">
          {peers.length === 0 ? (
            <li className="newws__note">no console is known yet</li>
          ) : (
            peers.map((peer) => {
              const url = `http://${peer.addr}`;
              const on = chosen.includes(url);
              const agents = peer.agents ?? [];
              const capable = agents.length === 0 || agents.includes(kind);
              return (
                <li key={peer.id}>
                  <label title={capable ? "" : `${peer.addr} has no ${kind}`}>
                    <input
                      type="checkbox"
                      data-target={peer.addr}
                      checked={on}
                      disabled={!capable}
                      onChange={() =>
                        setChosen(on ? chosen.filter((item) => item !== url) : [...chosen, url])
                      }
                    />
                    <span>{peer.addr}</span>
                    <span className="newws__dim">
                      {agents.length === 0 ? "no agent reported" : agents.join(" ")}
                    </span>
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
          send to {chosen.length} machine{chosen.length === 1 ? "" : "s"}
        </button>
        {problem !== "" && (
          <p className="newws__note newws__note--bad" role="status">
            {problem}
          </p>
        )}

        {dispatches.length > 0 && (
          <section className="dispatch__results" aria-label="Dispatches">
            <div className="newws__head">in flight</div>
            {dispatches.map((entry) => (
              <article key={entry.id} className="dispatch__entry" data-dispatch={entry.id}>
                <header>
                  <span>{entry.id}</span>
                </header>
                <ul>
                  {entry.jobs.map((job) => (
                    <li key={job.host} data-host={job.host}>
                      <span className="dispatch__host">{job.host}</span>
                      <span className="dispatch__status" data-status={job.status ?? job.error ? "bad" : ""}>
                        {job.error !== undefined && job.error !== ""
                          ? job.error
                          : job.status === "blocked"
                            ? "blocked — wants you"
                            : (job.status ?? "starting")}
                      </span>
                      {job.branch !== undefined && job.branch !== "" && (
                        <span className="newws__dim">{job.branch}</span>
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
        )}
      </div>
      </div>
    </div>
  );
}
