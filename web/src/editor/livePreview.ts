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
import {
  EditorSelection,
  type EditorState,
  type Extension,
  type Range,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { renderMermaid } from "../render/mermaid.js";

/** Split a GFM table row on unescaped pipes, dropping the leading/trailing ones. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  if (cells.length && cells[0]!.trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

const ALIGN_ROW = /^\s*:?-{1,}:?\s*$/;

/** Column alignments from the `|---|:--:|` delimiter row. */
function alignments(line: string): Array<"left" | "center" | "right"> {
  return splitRow(line).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
}

/**
 * A real <table> standing in for the markdown source, the way Bear and Typora
 * show one. Replaced back with the source as soon as the caret enters the
 * table, so it stays editable text rather than a widget you have to escape.
 *
 * Cell contents render as plain text on purpose: running them through a
 * markdown renderer here would mean a second, divergent rendering path for
 * something the view mode already does properly, and inline HTML inside an
 * editor widget is a reliable way to end up with unescaped input on screen.
 */
class TableWidget extends WidgetType {
  constructor(
    private readonly rows: string[][],
    private readonly align: Array<"left" | "center" | "right">,
    private readonly from: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return (
      this.from === other.from &&
      JSON.stringify(this.rows) === JSON.stringify(other.rows) &&
      JSON.stringify(this.align) === JSON.stringify(other.align)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-render";
    const table = document.createElement("table");
    const [head, ...body] = this.rows;

    if (head) {
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      head.forEach((cell, i) => {
        const th = document.createElement("th");
        th.textContent = cell;
        th.style.textAlign = this.align[i] ?? "left";
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    const tbody = document.createElement("tbody");
    for (const row of body) {
      const tr = document.createElement("tr");
      row.forEach((cell, i) => {
        const td = document.createElement("td");
        td.textContent = cell;
        td.style.textAlign = this.align[i] ?? "left";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    // Clicking the rendered table puts the caret in its source, which both
    // reveals the markdown and dismisses this widget.
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        selection: EditorSelection.cursor(this.from),
        scrollIntoView: true,
      });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * A rendered diagram standing in for its ```mermaid fence, on the same terms as
 * TableWidget: click it (or move the caret in) and you get the source back.
 *
 * Percent: this exists because the fork made the editor the default surface for
 * markdown. Before that, a document opened in the rendered view and a diagram
 * simply drew; afterwards, every doc with a diagram opened showing a wall of
 * fence source, and the only way to see the picture was to know about the view
 * toggle. Tables got this treatment first; a diagram is the construct where raw
 * source is *least* useful, so it needs it more, not less.
 */
class MermaidWidget extends WidgetType {
  private cleanup: (() => void) | null = null;

  constructor(
    private readonly src: string,
    private readonly from: number,
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return this.from === other.from && this.src === other.src;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-mermaid-render";
    const host = document.createElement("div");
    host.className = "mermaid";
    host.textContent = this.src;
    wrap.appendChild(host);

    // renderMermaid skips detached nodes on purpose (mermaid throws deep inside
    // its d3-selection code otherwise), and CodeMirror has not attached this
    // widget yet when toDOM returns — so paint on the next frame instead.
    const paint = (): void => {
      if (!wrap.isConnected) return;
      void renderMermaid(wrap);
    };
    requestAnimationFrame(paint);

    // The SVG bakes its theme in at render time, and a light↔dark flip changes
    // neither the document nor the selection — so the decoration set never
    // recomputes and the widget is never rebuilt. It has to repaint itself.
    const onTheme = (): void => {
      host.textContent = this.src;
      delete host.dataset.processed;
      host.removeAttribute("data-processed");
      host.classList.remove("mermaid-error");
      requestAnimationFrame(paint);
    };
    window.addEventListener("mdc-theme-resolved", onTheme);
    this.cleanup = (): void => window.removeEventListener("mdc-theme-resolved", onTheme);

    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        selection: EditorSelection.cursor(this.from),
        scrollIntoView: true,
      });
      view.focus();
    });
    return wrap;
  }

  destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Node types whose text is pure syntax — safe to hide when not being edited. */
/**
 * An explicit hard break (two trailing spaces, or a trailing backslash), drawn
 * as a visible glyph.
 *
 * It has to be visible because the renderer treats a plain newline as a soft
 * wrap: a hard break is now the ONLY way to force a line break, so it carries
 * meaning the rest of the document does not. Both spellings were unreadable
 * here — trailing spaces show nothing at all, and a backslash shows as a stray
 * backslash that looks like a typo. One glyph for both, and the raw characters
 * come back the moment the caret lands on that line.
 */
class HardBreakWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-hardbreak";
    el.textContent = "\u21b5"; // ↵
    el.title = "Hard line break";
    return el;
  }
  eq(): boolean {
    return true;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const CONCEALED_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "LinkMark",
]);

/** Inside a link or image, the destination is noise once the text is styled. */
const CONCEALED_IN_LINK = new Set(["URL"]);

const hidden = Decoration.replace({});
const hardBreak = Decoration.replace({ widget: new HardBreakWidget() });
const codeMark = Decoration.mark({ class: "cm-md-code" });
// Tables are the one construct a proportional face actively breaks: the pipes
// stop lining up and the source becomes unreadable while you edit it. A line
// decoration keeps the whole table monospace so the columns stay square.
const tableLine = Decoration.line({ class: "cm-md-table" });

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
  const lines: Array<Range<Decoration>> = tableSourceLines(view);

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

        // A hard break's node spans the trailing marker AND the newline that
        // follows it. Only the marker may be replaced — swallowing the newline
        // would splice the two lines into one on screen, which is the opposite
        // of what the break says.
        if (node.name === "HardBreak") {
          if (active.has(view.state.doc.lineAt(node.from).number)) return;
          const markerEnd = node.to - 1;
          if (markerEnd > node.from) {
            replaces.push({ from: node.from, to: markerEnd, value: hardBreak });
          }
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
  return Decoration.set([...lines, ...marks, ...deduped], true);
}

/** True when a selection or the caret is anywhere inside [from, to] — the signal
 *  that the user is editing this block, so it keeps its raw source. */
function editing(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.to >= from && r.from <= to);
}

/**
 * Block rendering lives in a StateField, not the view plugin: CodeMirror
 * refuses block-level decorations from a plugin ("Block decorations may not be
 * specified via plugins") because they change block layout, which the viewport
 * measurement depends on. A field is computed for the whole document, so this
 * one walks the full tree rather than the visible ranges — tables and diagrams
 * are rare enough that the cost is nil next to the inline pass.
 */
function buildBlockDecorations(state: EditorState): DecorationSet {
  const out: Array<Range<Decoration>> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "FencedCode") {
        const firstLine = state.doc.lineAt(node.from);
        const lastLine = state.doc.lineAt(node.to);
        if (editing(state, firstLine.from, lastLine.to)) return;
        const info = firstLine.text.replace(/^\s*[`~]{3,}/, "").trim().toLowerCase();
        if (info !== "mermaid") return;
        // Drop the opening fence, and the closing one when there is one — an
        // unclosed fence still renders whatever it has so far.
        const raw = state.doc.sliceString(firstLine.from, lastLine.to).split("\n");
        const closed = /^\s*[`~]{3,}\s*$/.test(raw[raw.length - 1] ?? "");
        const src = raw.slice(1, closed ? -1 : undefined).join("\n");
        if (src.trim() === "") return;
        out.push({
          from: firstLine.from,
          to: lastLine.to,
          value: Decoration.replace({
            block: true,
            widget: new MermaidWidget(src, firstLine.from),
          }),
        });
        return;
      }
      if (node.name !== "Table") return;
      const firstLine = state.doc.lineAt(node.from);
      const lastLine = state.doc.lineAt(node.to);
      // Caret inside the table means the user is editing it — leave the source
      // alone (livePreviewTheme keeps those lines monospace).
      if (editing(state, firstLine.from, lastLine.to)) return;
      const raw = state.doc.sliceString(firstLine.from, lastLine.to).split("\n");
      const align =
        raw[1] && splitRow(raw[1]).every((c) => ALIGN_ROW.test(c)) ? alignments(raw[1]) : [];
      const rows = raw
        .filter((_line, i) => i !== 1 || align.length === 0)
        .filter((l) => l.trim() !== "")
        .map(splitRow);
      if (rows.length === 0) return;
      out.push({
        from: firstLine.from,
        to: lastLine.to,
        value: Decoration.replace({
          block: true,
          widget: new TableWidget(rows, align, firstLine.from),
        }),
      });
    },
  });
  return Decoration.set(out, true);
}

const blockField = StateField.define<DecorationSet>({
  create: (state) => buildBlockDecorations(state),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return buildBlockDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Table lines keep a monospace face while the caret is inside them, so the
 * pipes line up as you type. Applied as a plain line decoration from the
 * plugin — this one is inline-level, so it is allowed there.
 */
function tableSourceLines(view: EditorView): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = [];
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const first = view.state.doc.lineAt(node.from);
      const last = view.state.doc.lineAt(node.to);
      if (!view.state.selection.ranges.some((r) => r.to >= first.from && r.from <= last.to)) return;
      for (let n = first.number; n <= last.number; n++) {
        out.push({ from: view.state.doc.line(n).from, to: view.state.doc.line(n).from, value: tableLine });
      }
    },
  });
  return out;
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
  // Hanging indent on soft wraps. A source line wider than the column wraps
  // again, and without this the overhang is indistinguishable from the next
  // line of the file — so a 100-column paragraph reads as an arbitrary ragged
  // block and you cannot tell which visual lines are real lines. The negative
  // text-indent pulls the FIRST line of each .cm-line back to the gutter and
  // leaves every continuation inset. Block widgets (tables, mermaid) render
  // outside .cm-line, so they are untouched.
  ".cm-content > .cm-line": {
    textIndent: "-1.4em",
    paddingLeft: "1.4em",
  },
  ".cm-md-code": {
    fontFamily: "var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "0.92em",
  },
  ".cm-md-hardbreak": {
    color: "var(--text-faint, var(--text-muted))",
    opacity: "0.55",
    fontSize: "0.85em",
    paddingLeft: "2px",
  },
  ".cm-md-table": {
    fontFamily: "var(--mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "0.9em",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-md-table-render": { margin: "12px 0", cursor: "text", overflowX: "auto" },
  ".cm-md-table-render table": {
    borderCollapse: "collapse",
    width: "100%",
    fontSize: "0.95em",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-md-table-render th, .cm-md-table-render td": {
    border: "1px solid var(--border)",
    padding: "6px 10px",
    textAlign: "left",
  },
  ".cm-md-table-render th": {
    background: "var(--bg-subtle, var(--nav-bg))",
    fontWeight: "600",
  },
});

export const livePreviewExtension: Extension = [blockField, livePreviewPlugin, livePreviewTheme];
