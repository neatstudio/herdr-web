/**
 * Grid or one: how much of a desktop stage a tab's split gets.
 *
 * The same two-word switch as the phone's lens, because it answers the same
 * kind of question (how much of this session do I see at once) and two visual
 * languages for it in one header would read as noise. It is desktop-only: on a
 * phone the stage already shows one pane, so there is nothing to trade.
 */
export function ArrangeSwitch({
  focus,
  onChange,
}: {
  focus: boolean;
  onChange: (focus: boolean) => void;
}) {
  return (
    <div className="lens__switch" role="group" aria-label="pane arrangement">
      <button
        type="button"
        className="lens__opt"
        aria-pressed={!focus}
        title="show every pane of this tab where herdr put it"
        onClick={() => onChange(false)}
      >
        grid
      </button>
      <button
        type="button"
        className="lens__opt"
        aria-pressed={focus}
        title="give the active pane the whole stage"
        onClick={() => onChange(true)}
      >
        one
      </button>
    </div>
  );
}
