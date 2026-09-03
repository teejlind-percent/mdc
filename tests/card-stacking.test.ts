import { describe, expect, it } from "vitest";

import { clusterAround, stackTops } from "../web/src/cardStack.js";

const START = 6;
const GAP = 8;
const tops = (
  cards: Array<{ anchor: number; height: number }>,
  focusIdx = -1,
): number[] => stackTops(cards, START, GAP, focusIdx);

/** No card may overlap the one before it. */
function noOverlap(result: number[], cards: Array<{ height: number }>): boolean {
  return result.every(
    (top, i) => i === 0 || top >= result[i - 1]! + cards[i - 1]!.height + GAP - 0.001,
  );
}

describe("comment card stacking", () => {
  // Three comments on one paragraph: same anchor region, tall cards.
  const cluster = [
    { anchor: 292, height: 213 },
    { anchor: 318, height: 213 },
    { anchor: 345, height: 213 },
  ];

  it("packs downward with nothing pinned, so late cards drift far below their anchors", () => {
    const r = tops(cluster);
    expect(r).toEqual([292, 513, 734]);
    expect(r[2]! - cluster[2]!.anchor).toBe(389); // the drift being fixed
    expect(noOverlap(r, cluster)).toBe(true);
  });

  it("pins the focused card as near its anchor as the cards above allow", () => {
    const r = tops(cluster, 2);
    // floors are 6 / 227 / 448 — 448 is the true best for card 3, down from 734.
    expect(r).toEqual([6, 227, 448]);
    expect(noOverlap(r, cluster)).toBe(true);
  });

  it("puts a pinned card exactly on its anchor when there is room above", () => {
    const roomy = [
      { anchor: 200, height: 100 },
      { anchor: 800, height: 100 },
      { anchor: 1000, height: 100 },
    ];
    expect(tops(roomy, 2)[2]).toBe(1000);
    expect(tops(roomy, 1)[1]).toBe(800);
  });

  it("does not let a crowded cluster drag a pin in a LATER cluster off its anchor", () => {
    // The bug this exists for: an over-full cluster at the top of the document
    // cascaded through the upward pass and pushed every pin below it down.
    const two = [
      { anchor: 292, height: 213 },
      { anchor: 318, height: 213 },
      { anchor: 345, height: 213 },
      { anchor: 1050, height: 173 },
      { anchor: 1077, height: 173 },
      { anchor: 1103, height: 173 },
    ];
    const r = tops(two, 5);
    // floors[5] = 6 + 213*3 + 173*2 + 8*5 = 1031 <= 1103, so the pin is free to
    // sit on its own anchor; the upper cluster just compresses to make room.
    expect(r[5]).toBe(1103);
    expect(noOverlap(r, two)).toBe(true);
    // and the upper cluster is still in document order, none above the column top
    expect(r[0]).toBeGreaterThanOrEqual(START);
  });

  it("never lets a card escape the top of the column; the pin gives way instead", () => {
    const r = tops(cluster, 2);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(START);
  });

  it("keeps cards below the pin packed downward from it", () => {
    const mixed = [
      { anchor: 100, height: 120 },
      { anchor: 400, height: 120 },
      { anchor: 420, height: 120 },
      { anchor: 440, height: 120 },
    ];
    const r = tops(mixed, 1);
    expect(r[1]).toBe(400);
    expect(r[2]).toBe(528); // 400 + 120 + 8
    expect(r[3]).toBe(656);
    expect(noOverlap(r, mixed)).toBe(true);
  });

  it("handles an empty list and an out-of-range focus index", () => {
    expect(tops([])).toEqual([]);
    expect(tops(cluster, 99)).toEqual(tops(cluster));
    expect(tops(cluster, -1)).toEqual(tops(cluster));
  });
});

describe("clustering", () => {
  it("groups comments packed onto one paragraph", () => {
    expect(clusterAround([292, 318, 345], 2)).toEqual([0, 1, 2]);
    expect(clusterAround([292, 318, 345], 0)).toEqual([0, 1, 2]);
  });

  it("does not reach across a gap to an unrelated cluster", () => {
    const anchors = [292, 318, 345, 1050, 1077, 1103];
    expect(clusterAround(anchors, 5)).toEqual([3, 4, 5]);
    expect(clusterAround(anchors, 0)).toEqual([0, 1, 2]);
  });

  it("leaves a well-spaced comment on its own", () => {
    expect(clusterAround([100, 900, 1800], 1)).toEqual([1]);
  });

  it("stops at the first gap, not the first close pair", () => {
    // 0-1 close, 1-2 far, 2-3 close: focusing 2 must not pull in 0 or 1.
    expect(clusterAround([100, 200, 900, 1000], 2)).toEqual([2, 3]);
  });

  it("handles an out-of-range focus", () => {
    expect(clusterAround([100, 200], -1)).toEqual([]);
    expect(clusterAround([100, 200], 5)).toEqual([]);
    expect(clusterAround([], 0)).toEqual([]);
  });
});
