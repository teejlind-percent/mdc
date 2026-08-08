/**
 * Live preview — Bear/Typora-style editing, where markdown renders as you type.
 *
 * The text you are editing stays plain markdown. This is a decoration layer
 * only: it hides the syntax characters (`#`, `**`, backticks, link brackets and
 * URLs) so a heading reads as a heading and bold reads as bold, and reveals
 * them again on whatever line the cursor is on, so the markup is always there
 * to edit rather than something you have to fight.
 *
 * That "still just markdown" property is the whole reason to do it this way
 * rather than a true WYSIWYG surface. Nothing round-trips through HTML, so no
 * table, nested list or code fence can be mangled by the editor, and edit
 * capture keeps diffing the same source it always did. The rendered view
 * remains the source of truth for how the document actually looks.
 *
 * Concealing is deliberately limited to inline markers. List bullets, quote
 * bars and fence lines stay visible: they carry structure you need to see while
 * writing, and hiding them makes it impossible to tell where a block ends.
 */

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Node types whose text is pure syntax — safe to hide when not being edited. */
const CONCEALED_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "LinkMark",
]);

/** Inside a link or image, the destination is noise once the text is styled. */
const CONCEALED_IN_LINK = new Set(["URL"]);

const hidden = Decoration.replace({});
const codeMark = Decoration.mark({ class: "cm-md-code" });

/**
 * Lines the caret or a selection touches. Those keep their raw markdown, so the
 * line you are working on always shows exactly what is in the file.
 */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const from = view.state.doc.lineAt(range.from).number;
    const to = view.state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return lines;
}

function buildDecorations(view: EditorView): DecorationSet {
  const active = activeLines(view);
  // Kept apart because the two kinds have different rules: mark decorations may
  // overlap freely, replace decorations may not overlap each other. Merging them
  // into one sorted builder meant a code span's monospace mark and its own
  // concealed backticks fought, and the mark lost.
  const marks: Array<Range<Decoration>> = [];
  const replaces: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.from === node.to) return;

        // Code keeps a monospace face whatever the surrounding prose uses —
        // it is the only signal left once the backticks are concealed.
        if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock") {
          marks.push({ from: node.from, to: node.to, value: codeMark });
          return;
        }

        // Backticks are concealed for an inline span only. A fence's ``` lines
        // are structure: hide them and there is no way to see where a code
        // block starts or ends, or to put the caret back outside it.
        if (node.name === "CodeMark") {
          if (node.node.parent?.name !== "InlineCode") return;
        } else if (
          !CONCEALED_MARKS.has(node.name) &&
          !(
            CONCEALED_IN_LINK.has(node.name) &&
            (node.node.parent?.name === "Link" || node.node.parent?.name === "Image")
          )
        ) {
          return;
        }

        // Reveal the raw markup on the line being edited.
        if (active.has(view.state.doc.lineAt(node.from).number)) return;

        // A heading's `#` is followed by a space that belongs to the syntax;
        // leaving it behind indents the heading by one character.
        let end = node.to;
        if (node.name === "HeaderMark" && view.state.doc.sliceString(end, end + 1) === " ") {
          end += 1;
        }
        replaces.push({ from: node.from, to: end, value: hidden });
      },
    });
  }

  replaces.sort((a, b) => a.from - b.from || a.to - b.to);
  const deduped: Array<Range<Decoration>> = [];
  let lastTo = -1;
  for (const r of replaces) {
    if (r.from < lastTo) continue; // a nested conceal — the outer one already hides it
    deduped.push(r);
    lastTo = r.to;
  }
  return Decoration.set([...marks, ...deduped], true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      // Selection matters as much as content here: moving the caret onto a line
      // is what reveals that line's markup.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Proportional type for prose, monospace only where it carries meaning.
 * Headings get their size from markdownHighlight's tag styles; this supplies
 * the face and the rhythm around them.
 */
const livePreviewTheme = EditorView.theme({
  ".cm-content": {
    fontFamily: "var(--doc-font, inherit)",
    fontVariantLigatures: "none",
  },
  ".cm-md-code": {
    fontFamily: "var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "0.92em",
  },
});

export const livePreviewExtension: Extension = [livePreviewPlugin, livePreviewTheme];
