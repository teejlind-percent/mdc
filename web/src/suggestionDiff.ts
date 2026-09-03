import { presentableDiff, type Change } from "@codemirror/merge";

/** A card stays expanded through ten RENDERED lines of diff. */
const SUGGESTION_DIFF_COLLAPSE_THRESHOLD = 10;

/**
 * Roughly how many characters of the diff's monospace face fit on one line of
 * the comment margin. The margin is ~250px wide and the diff renders at ~11px
 * monospace, so this is deliberately generous — over-estimating the width
 * under-estimates the height, which errs towards leaving a card expanded.
 */
const DIFF_CHARS_PER_LINE = 40;

export interface DiffPart {
  text: string;
  changed: boolean;
}

function split(
  text: string,
  changes: readonly Change[],
  side: "current" | "proposed",
): DiffPart[] {
  const parts: DiffPart[] = [];
  let cursor = 0;
  for (const change of changes) {
    const from = side === "current" ? change.fromA : change.fromB;
    const to = side === "current" ? change.toA : change.toB;
    if (from > cursor) parts.push({ text: text.slice(cursor, from), changed: false });
    if (to > from) parts.push({ text: text.slice(from, to), changed: true });
    cursor = to;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), changed: false });
  return parts;
}

export function shapeSuggestionDiff(current: string, proposed: string) {
  const changes = presentableDiff(current, proposed);
  return {
    current: split(current, changes, "current"),
    proposed: split(proposed, changes, "proposed"),
  };
}

/** Source lines — what the card reports as "+3 −6". */
function lineCount(text: string): number {
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

/**
 * Lines as RENDERED in the margin, which is what decides whether a card is too
 * tall to leave expanded.
 *
 * The collapse test used to count newlines, which is wrong for the documents
 * that actually go through review: they are hard-wrapped at 90-100 columns and
 * the margin is a ~40-character column, so each source line becomes two or
 * three on screen. A six-line block of prose counted as 6, stayed expanded, and
 * rendered an 857px card whose Accept button sat far below the fold — the
 * "huge suggested change" case. The displayed +/- counts stay in source lines,
 * where they mean something to the reader.
 */
function renderedLineCount(text: string): number {
  if (text === "") return 0;
  return text
    .split(/\r?\n/)
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / DIFF_CHARS_PER_LINE)), 0);
}

export interface SuggestionDiffLineCounts {
  added: number;
  removed: number;
  total: number;
}

/** Count the source/proposed lines represented by a suggestion card. */
export function suggestionDiffLineCounts(
  current: string,
  proposed: string,
): SuggestionDiffLineCounts {
  const removed = lineCount(current);
  const added = lineCount(proposed);
  return { added, removed, total: added + removed };
}

/** Large actionable diffs use the compact card summary and in-document preview. */
export function shouldCollapseSuggestionDiff(current: string, proposed: string): boolean {
  return (
    renderedLineCount(current) + renderedLineCount(proposed) >
    SUGGESTION_DIFF_COLLAPSE_THRESHOLD
  );
}
