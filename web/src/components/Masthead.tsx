import type { HerdrStatus } from "@/lib/herdr";
import { THEME_CHOICES, type ThemeChoice } from "@/lib/theme";

type Props = {
  status: HerdrStatus | null;
  choice: ThemeChoice;
  onChoice: (choice: ThemeChoice) => void;
  /** Opens the panel that shows what herdr is and can install or update it. */
  onHost: () => void;
};

export function Masthead({ status, choice, onChoice, onHost }: Props) {
  const live = status?.status === "ok";
  const version = status?.version ?? "—";
  const protocol = status?.protocol;

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
        <span>{live ? "daemon live" : status === null ? "not reachable" : "daemon down"}</span>
        <span className="cluster__sep" aria-hidden />
        <span>v{version}</span>
        {protocol !== undefined && (
          <>
            <span className="cluster__sep" aria-hidden />
            <span title={status?.protocolTested === false ? "protocol outside the tested range" : ""}>
              proto {protocol}
              {status?.protocolTested === false ? " !" : ""}
            </span>
          </>
        )}
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
