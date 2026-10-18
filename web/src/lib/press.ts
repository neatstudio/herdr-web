/*
 * Touch has no right-click, so a long press on a pane title has to open the
 * same menu. The press is cancelled by movement or by lifting early, because
 * both mean the operator is scrolling or tapping, not asking for a menu.
 */

export type PressHandlers = {
  onLongPress: (x: number, y: number) => void;
  durationMs?: number;
};

export function longPressHandlers({ onLongPress, durationMs = 450 }: PressHandlers) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    onTouchStart: (event: React.TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined) {
        return;
      }
      startX = touch.clientX;
      startY = touch.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        onLongPress(startX, startY);
      }, durationMs);
    },
    onTouchMove: (event: React.TouchEvent): void => {
      const touch = event.touches[0];
      if (touch === undefined) {
        return;
      }
      // A finger that moved is scrolling; do not steal the gesture.
      if (Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8) {
        cancel();
      }
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  };
}
