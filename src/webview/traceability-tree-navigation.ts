export const TRACEABILITY_ROW_HEIGHT = 28;
export const TRACEABILITY_OVERSCAN = 8;

export interface TraceabilityVisibleWindow {
  readonly start: number;
  readonly end: number;
}

export function visibleWindow(scrollTop: number, viewportHeight: number, count: number): TraceabilityVisibleWindow {
  const start = Math.max(0, Math.floor(scrollTop / TRACEABILITY_ROW_HEIGHT) - TRACEABILITY_OVERSCAN);
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / TRACEABILITY_ROW_HEIGHT) + TRACEABILITY_OVERSCAN);
  return { start, end };
}

export function revealIndex(index: number, scrollTop: number, viewportHeight: number, count: number): number {
  const top = index * TRACEABILITY_ROW_HEIGHT;
  const bottom = top + TRACEABILITY_ROW_HEIGHT;
  const viewportBottom = scrollTop + viewportHeight;
  if (top < scrollTop) {
    return top;
  }
  if (bottom > viewportBottom) {
    return Math.max(0, Math.min(bottom - viewportHeight, Math.max(0, count * TRACEABILITY_ROW_HEIGHT - viewportHeight)));
  }
  return scrollTop;
}

export function pageSize(viewportHeight: number): number {
  return Math.max(1, Math.floor(viewportHeight / TRACEABILITY_ROW_HEIGHT));
}

export function selectionRange(
  ids: readonly string[],
  anchorId: string,
  targetId: string,
  limit: number
): readonly string[] {
  const anchor = ids.indexOf(anchorId);
  const target = ids.indexOf(targetId);
  if (anchor < 0 || target < 0 || limit < 1) { return []; }
  return target >= anchor
    ? ids.slice(anchor, Math.min(target + 1, anchor + limit))
    : ids.slice(Math.max(target, anchor - limit + 1), anchor + 1);
}
