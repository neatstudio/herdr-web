import type { HerdrStatus } from "@/lib/herdr";
import { THEME_CHOICES, type ThemeChoice } from "@/lib/theme";
import { tailPath } from "@/lib/fleet";

type Props = {
  status: HerdrStatus | null;
  choice: ThemeChoice;
  onChoice: (choice: ThemeChoice) => void;
};

export function Masthead({ status, choice, onChoice }: Props) {
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

      <div className="cluster">
        <span className="signal" data-tone={live ? "working" : "blocked"} aria-hidden />
        <span>{live ? "daemon live" : (status?.status ?? "connecting")}</span>
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
        {status?.socket !== undefined && status.socket !== "" && (
          <>
            <span className="cluster__sep" aria-hidden />
            <span className="cluster__socket" title={status.socket}>
              {tailPath(status.socket, 2)}
            </span>
          </>
        )}
      </div>

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
