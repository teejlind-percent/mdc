/**
 * Building an anchor for a new comment from a document selection.
 *
 * An anchor stores the selected `quote`, a 1-indexed `line` in the raw markdown,
 * and — when the quote repeats — a surrounding-text `context` fingerprint that
 * pins the exact occurrence so the comment can't drift to a twin. Both are
 * computed against the SAME rendered-text layer the matcher searches, so capture
 * and match agree. The matching half (findAnchorMatch) and the shared text
 * primitives live in the core; this module is the create-time, DOM-aware side.
 */

import { allIndexesOf, captureContext, fuzzyFind, stripInlineMd } from "../../../src/anchor.js";
import type { AnchorContext } from "../api.js";

const BLOCK_TAGS = new Set([
  "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TD", "TH",
]);

/** The text content of the nearest block element enclosing a node. */
export function enclosingBlockText(node: Node): string {
  let el: HTMLElement | null =
    node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el ? (el.textContent ?? "") : "";
}

/**
 * Offset of a Range's start within `root`'s concatenated textContent — the
 * coordinate space the matcher operates in. Returns -1 if the start node isn't
 * under `root`.
 */
export function renderedOffsetOf(root: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let n = walker.nextNode();
  while (n) {
    if (n === range.startContainer) return cursor + range.startOffset;
    cursor += n.nodeValue?.length ?? 0;
    n = walker.nextNode();
  }
  return -1;
}

/**
 * Surrounding-context fingerprint for a quote, grown around the SELECTED
 * occurrence (identified by its rendered offset) until quote+context is unique,
 * capped each side. Returns undefined when the bare quote is already unique (no
 * context needed) or the selection can't be located.
 */
export function computeAnchorContext(
  root: HTMLElement,
  quote: string,
  selOffset: number,
): AnchorContext | undefined {
  const full = root.textContent ?? "";
  if (allIndexesOf(full, quote).length <= 1) return undefined; // unique → none

  // Window on the selected occurrence; fall back to the first if we couldn't
  // capture the offset.
  const at =
    selOffset >= 0 && full.substr(selOffset, quote.length) === quote
      ? selOffset
      : full.indexOf(quote);
  if (at < 0) return undefined;

  return captureContext(full, at, quote);
}

/**
 * 1-indexed raw-markdown line for a selection. Primary: the quote appears
 * verbatim in raw. Then: the same whitespace-normalized match the display
 * matcher uses — a quote spanning a hard wrap carries a space where raw has a
 * newline, and without this step it fell through to the block fallback and
 * reported the block's FIRST line for every such selection. Last: match the
 * enclosing block's text against markdown-stripped raw lines. Null when none
 * resolve.
 */
export function resolveLine(rawMd: string, quote: string, blockText: string): number | null {
  const rawIdx = rawMd.indexOf(quote);
  if (rawIdx >= 0) return rawMd.slice(0, rawIdx).split("\n").length;

  const fuzzy = fuzzyFind(rawMd, quote);
  if (fuzzy) return rawMd.slice(0, fuzzy.startIdx).split("\n").length;

  const key = blockText.slice(0, 40).trim();
  if (!key) return null;
  const lines = rawMd.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (stripInlineMd(lines[i]!).includes(key)) return i + 1;
  }
  return null;
}
