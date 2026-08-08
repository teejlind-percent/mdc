/**
 * Edit capture — turn a human's direct edits into review threads.
 *
 * mdc's suggestion flow runs one way: the agent proposes, the human accepts or
 * rejects on the card. The reverse had no representation at all. If the human
 * wanted to change a word they either did it in edit mode, where the agent
 * never learns what moved, or described the change in prose and made the agent
 * apply it.
 *
 * So: when a save comes from the editor, diff it against what was on disk and
 * record one thread per changed hunk, authored by the human. The edit is a real
 * edit — the file is written exactly as typed, nothing is held back — and the
 * thread is the notification. The agent reads them through the normal
 * `list-pending` / `get-thread` path and sees the precise before/after.
 *
 * Line-based, which is the right grain for prose: a reworded sentence is one
 * hunk, not a scatter of character runs.
 */

/** One contiguous run of changed lines. */
export interface EditHunk {
  /** Text that exists in the NEW document — what the thread anchors to. */
  quote: string;
  /** Previous wording; empty for a pure insertion. */
  before: string;
  /** New wording; empty for a pure deletion. */
  after: string;
}

/** Longest common subsequence over lines, as index pairs. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // Guard against pathological inputs: a full rewrite of a large file is not
  // worth a quadratic table, and the summary path handles it.
  if (n * m > 4_000_000) return [];
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

const firstNonEmpty = (lines: string[]): string | null => {
  for (const l of lines) if (l.trim()) return l.trim();
  return null;
};

/**
 * Changed hunks between two versions of a document.
 *
 * A hunk anchors to text present in the NEW document, so the thread resolves
 * against the file as it now stands. A pure deletion has no new text of its
 * own, so it anchors to the nearest surviving line above it.
 */
export function diffEdits(oldText: string, newText: string): EditHunk[] {
  if (oldText === newText) return [];
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const pairs = lcsPairs(a, b);

  const hunks: EditHunk[] = [];
  let ai = 0;
  let bi = 0;

  const flush = (oldLines: string[], newLines: string[], precedingCommon: string | null): void => {
    const before = oldLines.join("\n").trim();
    const after = newLines.join("\n").trim();
    if (!before && !after) return; // whitespace-only churn
    const quote = firstNonEmpty(newLines) ?? precedingCommon;
    if (!quote) return; // nothing in the new document to hang it on
    hunks.push({ quote, before, after });
  };

  let lastCommon: string | null = null;
  for (const [pa, pb] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (pa > ai || pb > bi) flush(a.slice(ai, pa), b.slice(bi, pb), lastCommon);
    if (pa < a.length) {
      const common = a[pa]!.trim();
      if (common) lastCommon = common;
    }
    ai = pa + 1;
    bi = pb + 1;
  }
  return hunks;
}

/** Plain-text thread body for a hunk — comment bodies render as plain text. */
export function hunkBody(hunk: EditHunk, author: string): string {
  const q = (s: string): string => `"${s.replace(/\s+/g, " ").trim()}"`;
  if (!hunk.before) return `✏️ ${author} added this while reviewing.`;
  if (!hunk.after) return `✏️ ${author} deleted ${q(hunk.before)} while reviewing.`;
  return `✏️ ${author} edited this while reviewing.\n\nwas: ${q(hunk.before)}\nnow: ${q(hunk.after)}`;
}

/**
 * Cap on threads written for a single save. A wholesale rewrite should not bury
 * the margin under a hundred cards; past the cap the caller writes one summary
 * instead, which is more useful anyway.
 */
export const MAX_CAPTURED_HUNKS = 15;
