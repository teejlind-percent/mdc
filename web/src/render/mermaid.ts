/**
 * Mermaid diagrams. The markdown renderer emits ```mermaid``` blocks as
 * `<div class="mermaid">` holding the raw source; after the doc is in the DOM,
 * run mermaid to turn each into an SVG. A block that fails to parse is marked
 * with a visible error style rather than breaking the page.
 *
 * Manual run (startOnLoad off) so it fires on every navigation, not just once.
 */

import mermaid from "mermaid";

// Re-initialize when the resolved theme changes: mermaid bakes its theme into the
// SVG at render time, so a light↔dark flip needs a fresh init + re-render.
let initializedFor: "light" | "dark" | null = null;
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/* Percent: diagrams used mermaid's stock "neutral"/"dark" themes, so a diagram was
   the one thing on the page rendering in library grey — visibly not part of the
   document it sat in. Reading the values out of the CSS custom properties instead
   of hardcoding them keeps tokens.css the single source of truth: retune a token
   there and diagrams follow, in both themes, with no second palette to maintain. */
function tok(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function ensureInit(): void {
  const theme = currentTheme();
  if (initializedFor === theme) return;
  const dark = theme === "dark";
  const text = tok("--text", dark ? "#f1f1f3" : "#0e0e10");
  const accent = tok("--accent", dark ? "#9d9bf5" : "#6661ed");
  const surface = tok("--surface", dark ? "#17171a" : "#ffffff");
  mermaid.initialize({
    startOnLoad: false,
    // "base" is the only built-in that honours themeVariables.
    theme: "base",
    securityLevel: "strict",
    fontFamily: tok("--doc-font", "sans-serif"),
    themeVariables: {
      background: surface,
      mainBkg: tok("--accent-tint", dark ? "#1e1d2e" : "#f0effd"),
      primaryColor: tok("--accent-tint", dark ? "#1e1d2e" : "#f0effd"),
      primaryTextColor: text,
      primaryBorderColor: accent,
      nodeBorder: accent,
      lineColor: tok("--text-muted", dark ? "#a0a0a8" : "#757579"),
      textColor: text,
      secondaryColor: tok("--code-bg", dark ? "#26262b" : "#f1f1f3"),
      tertiaryColor: tok("--bg-soft", dark ? "#1c1c20" : "#fafafc"),
      fontSize: "14px",
    },
  });
  initializedFor = theme;
}

export async function renderMermaid(root: HTMLElement): Promise<void> {
  // Only diagrams still attached to the live document. When the doc is
  // re-injected (e.g. React's dev double-invoke) the previous nodes detach
  // mid-render; running mermaid against a detached node throws deep inside its
  // d3-selection code. Skipping detached nodes avoids that transient noise.
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("div.mermaid")).filter(
    (n) => n.isConnected,
  );
  if (nodes.length === 0) return;
  // Stash each node's raw source before mermaid consumes it (it replaces the text
  // with an SVG). Needed to re-render with a new theme on a light/dark toggle.
  for (const n of nodes) {
    if (n.dataset.mermaidSrc === undefined && n.dataset.processed !== "true") {
      n.dataset.mermaidSrc = n.textContent ?? "";
    }
  }
  ensureInit();
  try {
    await mermaid.run({ nodes });
  } catch (err) {
    // run() may reject on the first bad node; mark any block still holding raw
    // source (no SVG yet) as broken so the rest of the page stays usable. Skip
    // detached nodes — their failure is the re-injection race, not bad syntax.
    // (A frequent bad-syntax culprit: `(`, `#`, or `:` inside node/participant
    // labels — mermaid's parser chokes on them.)
    root.querySelectorAll<HTMLElement>('div.mermaid:not([data-processed="true"])').forEach((n) => {
      if (!n.isConnected || n.querySelector("svg")) return;
      n.classList.add("mermaid-error");
      n.title = "Invalid mermaid diagram";
    });
    if (nodes.some((n) => n.isConnected)) console.warn("mermaid render error:", err);
  }
}

/**
 * Re-render every diagram with the current theme — for a light/dark toggle, where
 * the already-baked SVG carries the OLD theme. Restores each node's stashed raw
 * source, clears mermaid's processed marker, and re-runs (ensureInit picks up the
 * new theme). No-op if nothing was ever rendered (no stashed source).
 */
export async function reRenderMermaid(root: HTMLElement): Promise<void> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("div.mermaid")).filter(
    (n) => n.isConnected && n.dataset.mermaidSrc !== undefined,
  );
  if (nodes.length === 0) return;
  for (const n of nodes) {
    n.textContent = n.dataset.mermaidSrc ?? "";
    delete n.dataset.processed;
    n.removeAttribute("data-processed");
    n.classList.remove("mermaid-error");
  }
  await renderMermaid(root);
}
