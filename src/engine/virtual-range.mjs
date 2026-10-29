export function visibleRange(count, top, height, rowHeight = 48, overscan = 6) {
  if (top >= height || top + count * rowHeight <= 0) return { start: 0, end: 0 };
  return { start: Math.max(0, Math.floor(-top / rowHeight) - overscan),
    end: Math.min(count, Math.ceil((height - top) / rowHeight) + overscan) };
}
