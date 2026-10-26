/*
 * How a tab's panes are arranged. herdr gives every pane a box in terminal
 * cells relative to the tab's area, so proportions come straight from those
 * boxes and a nested split needs no special case: it is simply more boxes.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type LayoutPane = { id: string; focused: boolean; rect: Rect };

/** One split edge: its direction, where it sits inside its box, and how far along. */
export type LayoutSplit = { id: string; direction: "right" | "down"; ratio: number; rect: Rect };

export type PaneLayout = {
  tabId: string;
  workspaceId: string;
  zoomed: boolean;
  area: Rect;
  focusedPaneId: string;
  panes: LayoutPane[];
  splits: LayoutSplit[];
};

/** A tile's place on the page, as percentages of the stage. */
export type Tile = { id: string; focused: boolean; left: number; top: number; width: number; height: number };

/**
 * `side` keeps herdr's own arrangement, which is what a wide window can show.
 * `stack` puts the panes one above another, because two panes side by side on
 * a phone leaves neither readable. `focus` gives one pane the whole stage
 * while herdr keeps the tab as it is: four tiles on a laptop are four small
 * windows, and reading one of them is the other half of that trade.
 */
export type ArrangeMode = "side" | "stack" | "focus";

/**
 * Whether a tab draws a header over its pane. Two tiles always do — the header
 * is what tells them apart and carries each pane's close button. A tab with
 * more panes than tiles shown (herdr zoomed it, or the operator picked "focus")
 * keeps it too: it is the only thing left naming the visible pane and saying
 * that the rest still exist. A tab of one pane stays bare, because the stage
 * head above already says where it is and what state it is in.
 */
export function tileHeadVisible(tileCount: number, tabPaneCount: number): boolean {
  return tileCount > 1 || tabPaneCount > 1;
}

export function arrangeTiles(
  layout: PaneLayout | null,
  mode: ArrangeMode,
  focusPaneId?: string | null,
): Tile[] {
  if (layout === null || layout.panes.length === 0) {
    return [];
  }
  // A zoomed tab is one pane filling the area, whatever the boxes say.
  if (layout.zoomed) {
    const pane = layout.panes.find((item) => item.id === layout.focusedPaneId) ?? layout.panes[0];
    return [{ id: pane.id, focused: true, left: 0, top: 0, width: 100, height: 100 }];
  }
  if (mode === "focus") {
    // The pane the operator is working in wins over herdr's focus: clicking a
    // tile sends to it without moving herdr's own cursor.
    const pane =
      layout.panes.find((item) => item.id === focusPaneId) ??
      layout.panes.find((item) => item.id === layout.focusedPaneId) ??
      layout.panes.find((item) => item.focused) ??
      layout.panes[0];
    return [{ id: pane.id, focused: pane.focused, left: 0, top: 0, width: 100, height: 100 }];
  }
  if (mode === "stack") {
    const each = 100 / layout.panes.length;
    return layout.panes.map((pane) => ({
      id: pane.id,
      focused: pane.focused,
      left: 0,
      top: 0,
      width: 100,
      height: each,
    }));
  }
  const { width, height } = layout.area;
  if (width <= 0 || height <= 0) {
    // No geometry to trust: fall back to one column rather than dividing by zero.
    return layout.panes.map((pane, index) => ({
      id: pane.id,
      focused: pane.focused,
      left: 0,
      top: (index * 100) / layout.panes.length,
      width: 100,
      height: 100 / layout.panes.length,
    }));
  }
  return layout.panes.map((pane) => ({
    id: pane.id,
    focused: pane.focused,
    left: (pane.rect.x / width) * 100,
    top: (pane.rect.y / height) * 100,
    width: (pane.rect.width / width) * 100,
    height: (pane.rect.height / height) * 100,
  }));
}

/** The tabs of a workspace, in the order herdr lists their panes. */
export function tabsOf<T extends { id: string; tabId: string; focused?: boolean }>(
  panes: T[],
): { tabId: string; pane: T }[] {
  const seen = new Map<string, T>();
  for (const pane of panes) {
    const current = seen.get(pane.tabId);
    // The focused pane names its tab, so a tab reads as what herdr has in front.
    if (current === undefined || (pane.focused === true && current.focused !== true)) {
      seen.set(pane.tabId, pane);
    }
  }
  return [...seen.entries()].map(([tabId, pane]) => ({ tabId, pane }));
}

/** A split edge, ready to be drawn and dragged. */
export type SplitHandle = { paneId: string; direction: "right" | "down"; at: number };

/**
 * Where each split edge sits, as a percentage of the stage. A stacked phone
 * arrangement has no edges to offer, and neither has a zoomed tab: both are one
 * pane after the fact, so dragging one would resize nothing.
 */
export function splitsOf(layout: PaneLayout | null, mode: ArrangeMode): SplitHandle[] {
  if (
    layout === null ||
    mode === "stack" ||
    mode === "focus" ||
    layout.zoomed ||
    layout.area.width <= 0 ||
    layout.area.height <= 0
  ) {
    return [];
  }
  const handles: SplitHandle[] = [];
  for (const split of layout.splits ?? []) {
    const vertical = split.direction === "right";
    const edge = vertical
      ? split.rect.x + split.rect.width * split.ratio
      : split.rect.y + split.rect.height * split.ratio;
    // The pane on the near side of the edge is the one herdr moves: its far
    // edge is the line itself.
    const near = layout.panes
      .filter((pane) => {
        const far = vertical ? pane.rect.x + pane.rect.width : pane.rect.y + pane.rect.height;
        const start = vertical ? pane.rect.x : pane.rect.y;
        return far <= edge + 1 && start >= (vertical ? split.rect.x : split.rect.y) - 1;
      })
      .sort((left, right) =>
        vertical
          ? right.rect.x + right.rect.width - (left.rect.x + left.rect.width)
          : right.rect.y + right.rect.height - (left.rect.y + left.rect.height),
      )[0];
    if (near === undefined) {
      continue;
    }
    handles.push({
      paneId: near.id,
      direction: vertical ? "right" : "down",
      at: (edge / (vertical ? layout.area.width : layout.area.height)) * 100,
    });
  }
  return handles;
}
