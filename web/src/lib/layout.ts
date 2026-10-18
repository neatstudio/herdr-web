/*
 * How a tab's panes are arranged. herdr gives every pane a box in terminal
 * cells relative to the tab's area, so proportions come straight from those
 * boxes and a nested split needs no special case: it is simply more boxes.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type LayoutPane = { id: string; focused: boolean; rect: Rect };

export type PaneLayout = {
  tabId: string;
  workspaceId: string;
  zoomed: boolean;
  area: Rect;
  focusedPaneId: string;
  panes: LayoutPane[];
};

/** A tile's place on the page, as percentages of the stage. */
export type Tile = { id: string; focused: boolean; left: number; top: number; width: number; height: number };

/**
 * `side` keeps herdr's own arrangement, which is what a wide window can show.
 * `stack` puts the panes one above another, because two panes side by side on
 * a phone leaves neither readable.
 */
export type ArrangeMode = "side" | "stack";

export function arrangeTiles(layout: PaneLayout | null, mode: ArrangeMode): Tile[] {
  if (layout === null || layout.panes.length === 0) {
    return [];
  }
  // A zoomed tab is one pane filling the area, whatever the boxes say.
  if (layout.zoomed) {
    const pane = layout.panes.find((item) => item.id === layout.focusedPaneId) ?? layout.panes[0];
    return [{ id: pane.id, focused: true, left: 0, top: 0, width: 100, height: 100 }];
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
