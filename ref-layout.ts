export const MIN_REF_PILL_WIDTH = 44;
export const REF_PILL_GAP = 4;

export function visibleRefPillCount({
  availableWidth,
  counterWidths,
  limit,
  total,
}: {
  availableWidth: number;
  counterWidths: Readonly<Record<number, number>>;
  limit: number;
  total: number;
}): number {
  const maximumVisible = Math.min(total, limit);

  for (let visible = maximumVisible; visible >= 0; visible -= 1) {
    const hidden = total - visible;
    const itemCount = visible + (hidden > 0 ? 1 : 0);
    const counterWidth = hidden > 0 ? (counterWidths[hidden] ?? 0) : 0;
    const minimumWidth =
      visible * MIN_REF_PILL_WIDTH
      + counterWidth
      + Math.max(0, itemCount - 1) * REF_PILL_GAP;

    if (minimumWidth <= availableWidth) return visible;
  }

  return 0;
}
