/**
 * Derives a document's outline (its heading hierarchy) from raw markdown.
 *
 * The slug IDs here MUST match the ones the renderer assigns to headings so an
 * outline row can scroll to its heading by `#slug` — so this reuses the same
 * `slugify` and the same per-document dedupe (slug, slug-1, slug-2) the renderer
 * applies, and lexes with the same `Marked` config. Working from the source text
 * (not the rendered DOM) keeps the outline accurate while editing, with no
 * dependence on paint timing.
 */

import { Marked, type Tokens } from "marked";
import { slugify } from "./render/markdown.js";

/** A heading flattened from the document, in document order. */
export interface Heading {
  depth: number; // 1..6
  text: string;
  slug: string; // matches the rendered heading's id attribute
}

/** A heading plus its nested sub-headings, for the tree view. */
export interface OutlineNode extends Heading {
  children: OutlineNode[];
}

/** Extract every heading from markdown, in order, with renderer-matching slugs. */
export function extractHeadings(md: string): Heading[] {
  // Same config as renderMarkdown — `breaks` doesn't affect headings, but lexing
  // with the same instance keeps token parsing identical if that ever changes.
  // It must therefore track renderMarkdown's value, not be pinned separately.
  const marked = new Marked({ breaks: false });
  const tokens = marked.lexer(md);

  // Per-document slug counts, mirroring the renderer: repeated heading text →
  // slug, slug-1, slug-2, so a row's #slug lands on the right copy.
  const slugCounts = new Map<string, number>();
  const headings: Heading[] = [];

  for (const token of tokens) {
    if (token.type !== "heading") continue;
    const h = token as Tokens.Heading;
    const base = slugify(h.text) || "section";
    const n = slugCounts.get(base) ?? 0;
    slugCounts.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n}`;
    headings.push({ depth: h.depth, text: h.text, slug });
  }

  return headings;
}

/**
 * Fold a flat heading list into a tree by depth. A heading nests under the
 * nearest preceding heading that is shallower than it; skipped levels (h1 → h3,
 * with no h2 between) attach to whatever shallower heading is open, rather than
 * being dropped. Headings before any shallower one become roots.
 */
export function buildOutlineTree(headings: Heading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const h of headings) {
    const node: OutlineNode = { ...h, children: [] };
    // Pop until the top of the stack is a strictly shallower heading.
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= h.depth) {
      stack.pop();
    }
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }

  return roots;
}
