/**
 * Selection → "Comment" toolbar, and the pending-preview highlight.
 *
 * When the user selects text in the document a small floating toolbar appears at
 * the end of the selection; clicking it starts a pending comment. While a
 * comment is being composed the selected range is shown with a preview
 * highlight (distinct from a committed one), removed on submit or cancel.
 */

import { rangeRectNodes } from "./highlights.js";
import { combo } from "../keymap.js";

const PREVIEW_CLASS = "hl-rect pending-preview";

let toolbar: HTMLElement | null = null;

export function removeSelectionToolbar(): void {
  toolbar?.remove();
  toolbar = null;
}

/**
 * Show the "Comment" toolbar at the end of `range`. `onComment` fires with a
 * cloned range when the button is pressed.
 */
export function showSelectionToolbar(range: Range, onComment: (range: Range) => void): void {
  removeSelectionToolbar();
  const rects = range.getClientRects();
  const viewportH = document.documentElement.clientHeight;

  // Anchor on the last rect that is actually on screen, not simply the last
  // one. getClientRects() is in document order, so for a selection taller than
  // the viewport — or one made by dragging upwards — the final rect can sit far
  // below the fold, and a toolbar placed against it is invisible.
  const visible = Array.prototype.filter.call(
    rects,
    (r: DOMRect) => r.bottom > 0 && r.top < viewportH,
  ) as DOMRect[];
  const endRect =
    visible.length > 0
      ? visible[visible.length - 1]!
      : rects.length > 0
        ? rects[rects.length - 1]!
        : range.getBoundingClientRect();

  const tb = document.createElement("div");
  tb.className = "sel-toolbar";
  tb.innerHTML =
    `<button type="button" title="Comment (${combo("comment").display})">` +
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg> Comment</button>`;
  document.body.appendChild(tb);

  // .sel-toolbar is position:fixed, so these are viewport coordinates.
  const tbRect = tb.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(endRect.right - tbRect.width / 2, window.innerWidth - tbRect.width - 8),
  );
  // Below the selection by default; above it when there is no room below.
  let top = endRect.bottom + 6;
  if (top + tbRect.height > viewportH - 8) top = endRect.top - tbRect.height - 6;
  top = Math.max(8, Math.min(top, Math.max(8, viewportH - tbRect.height - 8)));
  tb.style.left = `${left}px`;
  tb.style.top = `${top}px`;

  const range0 = range.cloneRange();
  tb.querySelector("button")!.addEventListener("mousedown", (e) => {
    e.preventDefault();
    onComment(range0);
    removeSelectionToolbar();
  });
  toolbar = tb;
}

/** Paint `range` as preview rects into the highlight `overlay` — same overlay the
 *  committed highlights use, so the preview reads identically and never mutates
 *  the doc DOM. Replaces any existing preview. */
export function applyPreviewHighlight(overlay: HTMLElement, range: Range): void {
  clearPreviewHighlight(overlay);
  const base = overlay.getBoundingClientRect();
  for (const node of rangeRectNodes(range, base, PREVIEW_CLASS)) {
    overlay.appendChild(node);
  }
}

export function clearPreviewHighlight(overlay: HTMLElement | null): void {
  if (!overlay) return;
  for (const el of Array.from(overlay.querySelectorAll<HTMLElement>(".hl-rect.pending-preview"))) {
    el.remove();
  }
}
