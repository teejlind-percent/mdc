/**
 * Where each comment card sits in the margin.
 *
 * Cards are anchored to their highlight, but several comments on one paragraph
 * share an anchor and cannot all have it, so they pack. Which direction they
 * pack in is the whole design question, and it is answered differently
 * depending on whether the user is working in one of them.
 *
 * Split out of Comments.tsx as pure geometry: the focused case has enough edge
 * cases (crowded clusters, the top of the column, clusters that must not
 * interfere with each other) to be worth testing directly.
 */

/**
 * Given each card's anchor and height in document order, return each card's top.
 *
 * `focusIdx < 0` packs strictly downward — every card at its anchor, or below
 * the previous one when that anchor is taken. That is the resting layout, and
 * it means the third comment on a paragraph can sit hundreds of pixels below
 * the text it is about.
 *
 * With a card focused we do what Google Docs does instead: pin the ACTIVE card
 * to its own anchor and move the others out of its way — cards above pack
 * upward from its top edge, cards below downward from its bottom. The document
 * itself never has to move, which is the point: the comment column shares one
 * scroller with the document (see layout.css), so a card 400px below its anchor
 * cannot be focused without scrolling its own subject off screen.
 */
export function stackTops(
  cards: ReadonlyArray<{ anchor: number; height: number }>,
  start: number,
  gap: number,
  focusIdx = -1,
): number[] {
  const n = cards.length;
  const tops: number[] = new Array(n);
  if (n === 0) return tops;

  if (focusIdx < 0 || focusIdx >= n) {
    let cursor = start;
    for (let i = 0; i < n; i++) {
      tops[i] = Math.max(cards[i]!.anchor, cursor);
      cursor = tops[i]! + cards[i]!.height + gap;
    }
    return tops;
  }

  // floors[i] = the highest this card could ever sit, with everything above it
  // packed as tightly as the gap allows. It is a hard lower bound, and the
  // upward pass needs it because a cluster ABOVE the pinned card may have slack
  // of its own to give. Without it the upward pass just cascades, and one
  // over-full cluster near the top of the document drags every pin below it off
  // its anchor.
  const floors: number[] = new Array(n);
  let f = start;
  for (let i = 0; i < n; i++) {
    floors[i] = f;
    f += cards[i]!.height + gap;
  }

  tops[focusIdx] = Math.max(cards[focusIdx]!.anchor, floors[focusIdx]!);
  for (let i = focusIdx - 1; i >= 0; i--) {
    const limit = tops[i + 1]! - cards[i]!.height - gap;
    tops[i] = Math.min(Math.max(cards[i]!.anchor, floors[i]!), limit);
  }
  // A card forced above its floor means the ones above genuinely cannot fit:
  // the pin gives way by exactly the worst breach, rather than letting a card
  // escape the top of the column.
  let deficit = 0;
  for (let i = 0; i <= focusIdx; i++) deficit = Math.max(deficit, floors[i]! - tops[i]!);
  if (deficit > 0) for (let i = 0; i <= focusIdx; i++) tops[i]! += deficit;

  for (let i = focusIdx + 1; i < n; i++) {
    tops[i] = Math.max(cards[i]!.anchor, tops[i - 1]! + cards[i - 1]!.height + gap);
  }
  return tops;
}

