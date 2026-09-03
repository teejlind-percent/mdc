/**
 * Paints comment highlights as an overlay over the rendered document.
 *
 * Anchors are matched against the doc's concatenated text (so a quote spanning
 * inline formatting — `code`, **bold** — still resolves) to a live DOM Range.
 * Rather than wrapping that range in spans (which mutates the doc tree — splitting
 * blocks, fragmenting across inline elements), the range's client rectangles are
 * painted as positioned `<div>`s in a separate overlay layer. The document DOM is
 * never touched, so highlights are always continuous and never corrupt the page.
 *
 * Matching itself is the shared core's `findAnchorMatch`; this module does the
 * DOM measuring (offset map → range → client rects → overlay rects).
 */

import { findAnchorMatch } from "../../../src/anchor.js";
import type { DisplayThread } from "../commentData.js";

const RECT_SELECTOR = ".hl-rect";

interface NodeSpan {
  node: Text;
  start: number;
  end: number;
}

/** A thread matched to a live range in the current rendered doc. */
export interface ResolvedHighlight {
  commentId: string;
  range: Range;
}

/**
 * Resolve each live (non-resolved) thread's anchor to a Range in the rendered
 * doc. Returns the matched highlights plus the ids of threads whose quote can't
 * be found (orphans), for the sidebar to report. Mutates nothing.
 */
export function resolveAnchorRanges(
  root: HTMLElement,
  threads: DisplayThread[],
): { highlights: ResolvedHighlight[]; orphans: string[] } {
  // Offset map: each text node's [start, end) within the concatenated text.
  const textNodes: NodeSpan[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let n = walker.nextNode();
  while (n) {
    const len = n.nodeValue?.length ?? 0;
    textNodes.push({ node: n as Text, start: cursor, end: cursor + len });
    cursor += len;
    n = walker.nextNode();
  }
  const fullText = root.textContent ?? "";

  const highlights: ResolvedHighlight[] = [];
  const orphans: string[] = [];

  for (const t of threads) {
    if (t.resolved) continue;
    const anchor = t.top.anchor;
    if (!anchor) continue;
    const m = findAnchorMatch(anchor, fullText);
    if (!m) {
      orphans.push(t.top.id);
      continue;
    }
    const endIdx = m.startIdx + m.length;
    const startNode = textNodes.find((tn) => m.startIdx >= tn.start && m.startIdx < tn.end);
    const endNode = textNodes.find((tn) => endIdx > tn.start && endIdx <= tn.end);
    if (!startNode || !endNode) {
      orphans.push(t.top.id);
      continue;
    }
    const range = document.createRange();
    range.setStart(startNode.node, m.startIdx - startNode.start);
    range.setEnd(endNode.node, endIdx - endNode.start);
    highlights.push({ commentId: t.top.id, range });
  }

  return { highlights, orphans };
}

/**
 * Paint resolved highlights as positioned rects into `overlay`. The overlay is an
 * absolutely-positioned layer whose offset parent is shared with the doc body, so
 * a range's viewport client-rects convert to overlay-local coordinates by
 * subtracting the overlay's own client rect. Clears and repaints from scratch —
 * cheap, and the only correct response to any layout change.
 *
 * One `<div.hl-rect>` per line-box of each range (so a multi-line highlight is a
 * stack of rects), all tagged with the comment id so they read and behave
 * as one highlight. Rects are interactive (click → onClick); the overlay itself
 * is pointer-transparent.
 */
export function paintHighlightRects(
  overlay: HTMLElement,
  highlights: ResolvedHighlight[],
  onClick: (commentId: string) => void,
): void {
  // Clear only committed rects — a live composition's preview rect (painted by
  // selection.ts) must survive a repaint of the committed highlights.
  for (const el of Array.from(overlay.querySelectorAll(".hl-rect:not(.pending-preview)"))) {
    el.remove();
  }
  const base = overlay.getBoundingClientRect();
  for (const hl of highlights) {
    // All line-rects of one comment hover/flash together so a multi-line
    // highlight reads as a single mark, not separate per-line boxes.
    const group = rangeRectNodes(hl.range, base, "hl-rect");
    const setHover = (on: boolean) => {
      for (const r of group) r.classList.toggle("hover", on);
    };
    for (const node of group) {
      node.dataset.commentId = hl.commentId;
      node.addEventListener("click", () => onClick(hl.commentId));
      node.addEventListener("mouseenter", () => setHover(true));
      node.addEventListener("mouseleave", () => setHover(false));
      overlay.appendChild(node);
    }
  }
}

export interface LineRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Return the visible part of a line rect, or null when it is fully clipped. */
export function clipLineRect(line: LineRect, clip: DOMRect): LineRect | null {
  const clipped = {
    left: Math.max(line.left, clip.left),
    right: Math.min(line.right, clip.right),
    top: Math.max(line.top, clip.top),
    bottom: Math.min(line.bottom, clip.bottom),
  };
  return clipped.left < clipped.right && clipped.top < clipped.bottom ? clipped : null;
}

function clippingRectForRange(range: Range): DOMRect | null {
  // The overlay is a sibling of the document, so it does not inherit an
  // ancestor's overflow clip. Mirror the nearest clip in viewport coordinates
  // before converting the result into overlay-local coordinates.
  let element =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  while (element) {
    const style = getComputedStyle(element);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const rect = element.getBoundingClientRect();
      return new DOMRect(
        rect.left + element.clientLeft,
        rect.top + element.clientTop,
        element.clientWidth,
        element.clientHeight,
      );
    }
    element = element.parentElement;
  }
  return null;
}

/**
 * Merge a range's raw client-rects into one rect per visual line.
 *
 * `getClientRects()` returns a rect per inline fragment — so a line containing
 * an inline `code` box (which has its own padding/box) yields several rects,
 * some overlapping at slightly different heights → doubled underlines. Grouping
 * by vertical band and taking the line's full left→right extent (and a common
 * bottom) gives ONE clean rect per line: no doubles, and the highlight reads and
 * flashes as whole lines rather than fragments.
 */
function mergeRectsByLine(range: Range): LineRect[] {
  const lines: LineRect[] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width === 0 || r.height === 0) continue;
    // Same line if the rect's vertical center sits within an existing band.
    const mid = r.top + r.height / 2;
    const line = lines.find((l) => mid >= l.top && mid <= l.bottom);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return lines;
}

/**
 * Build one positioned `<div>` per visible visual line of `range`, in the overlay's
 * local coordinate space (`base` = the overlay's own client rect). Shared by
 * committed highlights and the pending-composition preview.
 */
export function rangeRectNodes(
  range: Range,
  base: DOMRect,
  className: string,
): HTMLDivElement[] {
  const out: HTMLDivElement[] = [];
  const clip = clippingRectForRange(range);
  for (const line of mergeRectsByLine(range)) {
    const visibleLine = clip ? clipLineRect(line, clip) : line;
    if (!visibleLine) continue;
    const rect = document.createElement("div");
    rect.className = className;
    rect.style.left = `${visibleLine.left - base.left}px`;
    rect.style.top = `${visibleLine.top - base.top}px`;
    rect.style.width = `${visibleLine.right - visibleLine.left}px`;
    rect.style.height = `${visibleLine.bottom - visibleLine.top}px`;
    out.push(rect);
  }
  return out;
}

/** The live screen Y of a highlight relative to a container's scroll origin. */
export function highlightY(
  overlay: HTMLElement,
  commentId: string,
  container: HTMLElement,
): number | null {
  const el = overlay.querySelector<HTMLElement>(
    `${RECT_SELECTOR}[data-comment-id="${CSS.escape(commentId)}"]`,
  );
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // A rect hidden while its thread's preview is pinned measures 0x0; report it
  // as missing so the caller keeps the last known Y instead of reading zeros.
  if (rect.width === 0 && rect.height === 0) return null;
  const containerRect = container.getBoundingClientRect();
  return rect.top - containerRect.top + container.scrollTop;
}

/** A highlight's bounding rect in VIEWPORT coordinates, or null if unpainted. */
export function highlightViewportRect(
  overlay: HTMLElement,
  commentId: string,
): DOMRect | null {
  const el = overlay.querySelector<HTMLElement>(
    `${RECT_SELECTOR}[data-comment-id="${CSS.escape(commentId)}"]`,
  );
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/** Scroll the doc so a highlight is visible, with a brief flash on its rects. */
export function scrollToHighlight(overlay: HTMLElement, commentId: string): void {
  const els = Array.from(
    overlay.querySelectorAll<HTMLElement>(
      `${RECT_SELECTOR}[data-comment-id="${CSS.escape(commentId)}"]`,
    ),
  );
  if (els.length === 0) return;
  // Only scroll if the text is actually out of reach. Clicking a card whose
  // highlight is already on screen used to re-centre the page under the user
  // for no reason; with cards pinned to their anchors that is the common case,
  // and the jolt reads as the document running away from the click.
  const rect = els[0]!.getBoundingClientRect();
  const viewH = window.innerHeight || document.documentElement.clientHeight;
  const margin = Math.min(80, viewH * 0.15);
  const comfortablyVisible = rect.top >= margin && rect.bottom <= viewH - margin;
  if (!comfortablyVisible) els[0]!.scrollIntoView({ behavior: "smooth", block: "center" });
  // Re-trigger the flash even if a previous one is still mid-animation: drop the
  // class, then re-add on the next frame. Flash every rect of the highlight.
  for (const el of els) el.classList.remove("flash");
  requestAnimationFrame(() => {
    for (const el of els) el.classList.add("flash");
  });
  setTimeout(() => {
    for (const el of els) el.classList.remove("flash");
  }, 1300);
}
