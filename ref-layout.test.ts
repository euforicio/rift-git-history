import { describe, expect, it } from "vitest";
import { visibleRefPillCount } from "./ref-layout";

const counterWidths = { 1: 18, 2: 18, 3: 18 };

describe("visibleRefPillCount", () => {
  it("keeps two pills when both can retain their minimum width", () => {
    expect(visibleRefPillCount({
      availableWidth: 114,
      counterWidths,
      limit: 2,
      total: 3,
    })).toBe(2);
  });

  it("drops a pill whole and reserves the overflow counter", () => {
    expect(visibleRefPillCount({
      availableWidth: 80,
      counterWidths,
      limit: 2,
      total: 3,
    })).toBe(1);
  });

  it("shows only the counter when a pill cannot reach 44px", () => {
    expect(visibleRefPillCount({
      availableWidth: 60,
      counterWidths,
      limit: 2,
      total: 3,
    })).toBe(0);
  });
});
