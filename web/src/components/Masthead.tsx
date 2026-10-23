import { useEffect } from "react";
import { hostOctet } from "@/lib/fleet";
import type { HerdrStatus } from "@/lib/herdr";
import { THEME_CHOICES, type ThemeChoice } from "@/lib/theme";

type Props = {
  status: HerdrStatus | null;
  /** The build this console runs, which is not the daemon's version. */
  consoleVersion: string;
  choice: ThemeChoice;
  onChoice: (choice: ThemeChoice) => void;
  /** Opens the panel that shows what herdr is and can install or update it. */
  onHost: () => void;
  /** Opens the full-screen fleet task board. */
  onFleet: () => void;
};

export function Masthead({ status, consoleVersion: build, choice, onChoice, onHost, onFleet }: Props) {
  const live = status?.status === "ok";
  const protocol = status?.protocol;
  const octet = hostOctet(typeof window === "undefined" ? "" : window.location.hostname);
  // The name says which machine this is and which build it runs: herdr(4)v0.3.1
  // on a tailnet address, herdr v0.3.1 on this machine. The daemon's own version
  // is not in it — it changes for reasons that have nothing to do with which
  // console a tab belongs to, and the panel is where it belongs.
  const consoleVersion = build === "" ? "—" : build;
  const label = octet === "" ? `herdr ${consoleVersion}` : `herdr(${octet})${consoleVersion}`;

  // The tab strip is the one place several consoles are seen at once, and there
  // they all said "herdr": the title carries the same name as the masthead so a
  // window switcher can tell the machines apart.
  useEffect(() => {
    document.title = label;
  }, [label]);

  return (
    <header className="masthead">
      <div className="wordmark">
        <span className="wordmark__dot" aria-hidden />
        <span>herdr</span>
      </div>
      <span className="wordmark__tag">agent workspace control</span>

      <div className="masthead__spacer" />

      {/* The daemon state is also the way in to installing or updating herdr,
          which matters most when the daemon is exactly what is missing. */}
      <button
        type="button"
        id="herdr-host-open"
        className="cluster cluster--button"
        title="herdr status, install and update"
        onClick={onHost}
      >
        <span className="signal" data-tone={live ? "working" : "blocked"} aria-hidden />
        {/* Split so a phone can drop the build and keep the machine: the name of
            the machine is why a tab exists, the build is in the panel. */}
        <span id="herdr-daemon-label">
          <span className="masthead__host">{octet === "" ? "herdr" : `herdr(${octet})`}</span>
          {" "}
          <span className="masthead__version">{consoleVersion}</span>
        </span>
        {protocol !== undefined && (
          <span
            className="cluster__dim"
            title={status?.protocolTested === false ? "protocol outside the tested range" : ""}
          >
            {status?.protocolTested === false ? "proto !" : `p${protocol}`}
          </span>
        )}
        {!live && <span className="cluster__dim">{status === null ? "offline" : "down"}</span>}
      </button>

      <button
        type="button"
        id="herdr-fleet-open"
        className="cluster cluster--button"
        title="open the fleet task board"
        onClick={onFleet}
      >
        fleet
      </button>

      <div className="switch" role="group" aria-label="Theme">
        {THEME_CHOICES.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === choice}
            onClick={() => onChoice(item)}
          >
            {item}
          </button>
        ))}
      </div>
    </header>
  );
}
