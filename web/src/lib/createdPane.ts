import type { HerdrPane } from "./herdr";

/**
 * A pane the console has just asked herdr to make.
 *
 * Creating a tab answers with the new pane's id at once, but `panes` answers
 * from the daemon's own view, and that view can still be a poll behind: the next
 * listing carries the old panes only. Reading "not listed" as "gone" is what
 * threw the view back to the pane that was open before, so a pane the console
 * has just made is believed for a while instead.
 */
export type CreatedPane = {
  pane: HerdrPane;
  /** When the create call answered, on the caller's clock. */
  at: number;
};

/** A poll's pane list, with a pane that is only just created still in it. */
export type HeldPanes = {
  /** What the caller should remember for the next poll. */
  pending: CreatedPane | null;
  panes: HerdrPane[];
};

/**
 * Keep a just-created pane in a poll's answer until herdr lists it.
 *
 * Three outcomes, and the caller only has to store `pending` back:
 *
 * - herdr lists the pane: the poll is the truth from here on, so the pane is not
 *   added twice and nothing is held any more;
 * - herdr does not list it yet: it is appended, so the view keeps the pane it
 *   asked for;
 * - the grace has run out: the pane was not made, or was made and is already
 *   gone. Either way it is dropped and the poll wins, because a pane that never
 *   appears must not hold the view for ever.
 */
export function holdCreatedPane(
  created: CreatedPane | null,
  polled: readonly HerdrPane[],
  now: number,
  graceMs: number,
): HeldPanes {
  if (created === null) {
    return { pending: null, panes: [...polled] };
  }
  if (polled.some((pane) => pane.id === created.pane.id)) {
    return { pending: null, panes: [...polled] };
  }
  if (now - created.at >= graceMs) {
    return { pending: null, panes: [...polled] };
  }
  return { pending: created, panes: [...polled, created.pane] };
}
