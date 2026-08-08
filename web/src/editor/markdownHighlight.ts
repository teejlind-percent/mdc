/**
 * Markdown syntax highlighting for the editor: a CodeMirror HighlightStyle
 * mapping lezer tags to the app's theme tokens, so edit mode echoes the
 * rendered view's hierarchy (headings, emphasis, code, links).
 */

import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const markdownHighlightSpecs = [
  { tag: tags.heading1, color: "var(--text)", fontFamily: "var(--heading-font)", fontWeight: "700", fontSize: "1.4em" },
  { tag: tags.heading2, color: "var(--text)", fontFamily: "var(--heading-font)", fontWeight: "700", fontSize: "1.3em" },
  { tag: tags.heading3, color: "var(--text)", fontFamily: "var(--heading-font)", fontWeight: "700", fontSize: "1.2em" },
  { tag: tags.heading4, color: "var(--text)", fontFamily: "var(--heading-font)", fontWeight: "700", fontSize: "1.1em" },
  { tag: tags.heading5, color: "var(--text)", fontFamily: "var(--heading-font)", fontWeight: "700", fontSize: "1.05em" },
  { tag: tags.heading6, color: "var(--text)", fontFamily: "var(--heading-font)", fontWeight: "700", fontSize: "1em" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  // Code = full-strength text, NO background. Code is content you read, not
  // decoration, so it sits at --text (a dimmer rung is illegible in dark). A
  // HighlightStyle backgroundColor is applied per-token — it paints a ragged,
  // gap-riddled highlight rather than a clean block fill — so no background at
  // all. Edit mode is a markdown-source editor, not a nested-language
  // highlighter (that's view mode's hljs); the fence markers already mark code.
  { tag: tags.monospace, color: "var(--text)" },
  { tag: tags.link, color: "var(--accent)" },
  // URL destination recedes vs. content but stays readable: --text-muted, not
  // --text-faint (which is illegible against the dark editor background).
  { tag: tags.url, color: "var(--text-muted)" },
  { tag: tags.quote, color: "var(--text-muted)", fontStyle: "italic" },
  // Markup punctuation (the **, ##, backticks, --- fences) recedes but stays
  // legible: --text-muted, not the near-invisible --text-faint. contentSeparator
  // (--- rules / frontmatter fences) rides this group as plain dimmed markers —
  // NOT the code tint. tags.list is deliberately unstyled: it spans the whole
  // list item in the parser, so dimming it dims the item text too.
  {
    tag: [tags.processingInstruction, tags.meta, tags.contentSeparator],
    color: "var(--text-muted)",
    fontStyle: "normal",
    fontWeight: "400",
  },
] satisfies readonly TagStyle[];

export const markdownHighlightStyle = HighlightStyle.define(markdownHighlightSpecs);

export const markdownHighlightExtension = syntaxHighlighting(markdownHighlightStyle);
