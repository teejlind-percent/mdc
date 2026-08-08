/**
 * Percent fork additions — a resizable comment margin and a whole-document
 * comment composer.
 *
 * Deliberately written as an additive layer that works on the rendered DOM
 * rather than inside the React tree: it touches no component state, so it stays
 * easy to rebase when upstream moves. Everything it does is idempotent.
 *
 *   1. A draggable divider between the document and the comment margin. Both
 *      side columns ship as fixed px (see tokens.css), which is fine
 *      full-width and starves the document in a side-by-side editor pane. The
 *      file list stays fixed and collapsible; only the comment margin is
 *      draggable, and its width persists. Double-click the divider to reset.
 *   2. A chat-style composer docked at the foot of the comment margin, for a
 *      comment on the document as a whole. mdc has no native concept of one —
 *      every thread must carry a non-empty anchor quote and the only way to
 *      make one is to select text — so this anchors to the document's title
 *      line and posts through the ordinary comments API. The result is an
 *      ordinary thread: `list-pending`, `get-thread` and `reply` all see it.
 *
 * It also keeps `--pct-doc-pad` (doc.css) in step with the column width.
 */

const SIDE_KEY = "pct.mdc.sidebarW";

const MIN_SIDE = 200;
const MAX_SIDE = 620;
const MIN_DOC = 240;

/* ------------------------------------------------------------------ widths */

function navWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--nav-w");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 200;
}

function readStored(): number | null {
  const raw = Number(localStorage.getItem(SIDE_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Proportional default, so the document keeps a usable measure at any pane width. */
const defaultSide = (total: number): number =>
  Math.round(Math.min(340, Math.max(MIN_SIDE, total * 0.3)));

function clampSide(side: number, total: number): number {
  const ceiling = Math.max(MIN_SIDE, total - navWidth() - MIN_DOC);
  return Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.min(side, ceiling))));
}

const state = { side: 0, pinned: false };

const layoutEl = (): HTMLElement | null => document.querySelector<HTMLElement>(".layout");

/**
 * The width lives in a stylesheet we own rather than in inline style on
 * `.layout`. Inline style is React's territory: it re-renders the layout on
 * file switches and drops properties it did not set, and because that is an
 * attribute write on an existing node, neither a childList MutationObserver nor
 * a ResizeObserver fires to tell us to restore it.
 */
let styleEl: HTMLStyleElement | null = null;
function writeVars(side: number): void {
  if (!styleEl || !styleEl.isConnected) {
    styleEl = document.createElement("style");
    styleEl.id = "pct-mdc-vars";
    document.head.appendChild(styleEl);
  }
  const css = `.layout{--sidebar-w:${side}px}`;
  if (styleEl.textContent !== css) styleEl.textContent = css;
}

function applyWidths(): void {
  const el = layoutEl();
  if (!el) return;
  const total = Math.round(el.getBoundingClientRect().width);
  if (!total) return;
  state.side = clampSide(state.pinned ? state.side : defaultSide(total), total);
  writeVars(state.side);
  positionGrip();
}

/*
 * Every write below is guarded on an actual change. The MutationObserver fires
 * on every React render and mdc re-renders the margin constantly during a
 * review; unconditional style writes there become a permanent
 * write -> forced-layout -> write loop that pins a core.
 */
let syncTimer: ReturnType<typeof setTimeout> | 0 = 0;
function scheduleSync(): void {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = 0;
    applyWidths();
    syncDocPadding();
    positionComposer();
  }, 120);
}

/* -------------------------------------------------------------------- grip */

let grip: HTMLElement | null = null;
const lastGrip: { display: string | null; left: string | null } = { display: null, left: null };

function positionGrip(): void {
  if (!grip) return;
  const el = layoutEl();
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  if (!el || !sidebar || el.classList.contains("sidebar-collapsed")) {
    if (lastGrip.display !== "none") grip.style.display = lastGrip.display = "none";
    return;
  }
  if (lastGrip.display !== "") grip.style.display = lastGrip.display = "";
  const left = `${Math.round(sidebar.getBoundingClientRect().left - 4)}px`;
  if (lastGrip.left !== left) grip.style.left = lastGrip.left = left;
}

function makeGrip(): HTMLElement {
  const g = document.createElement("div");
  g.className = "pct-grip";
  g.setAttribute("role", "separator");
  g.setAttribute("aria-orientation", "vertical");
  g.title = "Drag to resize the comment margin — double-click to reset";

  let startX = 0;
  let startVal = 0;
  let dragging = false;

  g.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startVal = state.side;
    g.setPointerCapture(e.pointerId);
    g.classList.add("pct-grip-active");
    document.body.classList.add("pct-resizing");
    e.preventDefault();
  });

  g.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const el = layoutEl();
    if (!el) return;
    const total = Math.round(el.getBoundingClientRect().width);
    // dragging the divider right narrows the comment margin
    state.side = clampSide(startVal - (e.clientX - startX), total);
    state.pinned = true;
    writeVars(state.side);
    positionGrip();
    syncDocPadding();
    positionComposer();
  });

  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      g.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    g.classList.remove("pct-grip-active");
    document.body.classList.remove("pct-resizing");
    localStorage.setItem(SIDE_KEY, String(state.side));
  };
  g.addEventListener("pointerup", end);
  g.addEventListener("pointercancel", end);

  g.addEventListener("dblclick", () => {
    state.pinned = false;
    localStorage.removeItem(SIDE_KEY);
    applyWidths();
    syncDocPadding();
    positionComposer();
  });

  document.body.appendChild(g);
  return g;
}

/* -------------------------------------------------------------- doc gutter */

let lastPad: number | null = null;
function syncDocPadding(): void {
  const area = document.querySelector<HTMLElement>(".doc-area");
  if (!area) return;
  const w = area.getBoundingClientRect().width;
  const pad = w >= 760 ? 56 : w >= 560 ? 40 : w >= 420 ? 28 : 18;
  if (pad === lastPad) return;
  lastPad = pad;
  area.style.setProperty("--pct-doc-pad", `${pad}px`);
}

/* ------------------------------------------------- whole-document comment */

let currentUser: string | null = null;
void fetch("/api/index")
  .then((r) => r.json())
  .then((d: { user?: string }) => {
    currentUser = d.user ?? null;
  })
  .catch(() => {
    /* the composer still posts; the server falls back to its own identity */
  });

/** The rendered title line, used as the anchor quote. */
function docTitleText(): string | null {
  const doc = document.querySelector<HTMLElement>(".doc");
  if (!doc) return null;
  const content = doc.querySelector<HTMLElement>(":scope > div:not(.hl-overlay)");
  if (!content) return null;
  const el =
    content.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6") ??
    (content.firstElementChild as HTMLElement | null);
  const text = el?.textContent?.trim() ?? "";
  return text || null;
}

function currentFile(): string | null {
  const q = new URLSearchParams(location.search).get("file");
  if (q) return q;
  const crumb = document.querySelector<HTMLElement>(".breadcrumb");
  return crumb?.textContent?.trim() || null;
}

async function postDocComment(body: string): Promise<void> {
  const file = currentFile();
  const quote = docTitleText();
  if (!file || !quote) throw new Error("no document open");
  const res = await fetch(`/api/comments?file=${encodeURIComponent(file)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body,
      author: currentUser ?? undefined,
      parent_id: null,
      anchor: { quote },
    }),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || res.statusText);
}

let composer: HTMLElement | null = null;
const lastComposer: {
  display: string | null;
  left: string | null;
  width: string | null;
  pad: string | null;
} = { display: null, left: null, width: null, pad: null };

function positionComposer(): void {
  if (!composer) return;
  const layout = layoutEl();
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const hidden =
    !layout ||
    !sidebar ||
    layout.classList.contains("sidebar-collapsed") ||
    !document.querySelector(".doc");
  if (hidden) {
    if (lastComposer.display !== "none") composer.style.display = lastComposer.display = "none";
    return;
  }
  if (lastComposer.display !== "") composer.style.display = lastComposer.display = "";

  const r = sidebar.getBoundingClientRect();
  const left = `${Math.round(r.left)}px`;
  const width = `${Math.round(r.width)}px`;
  if (lastComposer.left !== left) composer.style.left = lastComposer.left = left;
  if (lastComposer.width !== width) composer.style.width = lastComposer.width = width;

  // Reserve the composer's height at the foot of the column so a thread can
  // always be scrolled clear of it. offsetHeight forces layout, so only read it
  // when the value could have changed.
  const inner = document.querySelector<HTMLElement>(".sidebar-inner");
  if (!inner) return;
  const pad = `${composer.offsetHeight + 16}px`;
  if (lastComposer.pad !== pad) inner.style.paddingBottom = lastComposer.pad = pad;
}

function makeComposer(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pct-composer";

  const ta = document.createElement("textarea");
  ta.className = "pct-composer-input";
  ta.rows = 1;
  ta.placeholder = "Add comment";

  const row = document.createElement("div");
  row.className = "pct-composer-row";
  const hint = document.createElement("span");
  hint.className = "pct-composer-hint";
  hint.textContent = "whole document";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "pct-composer-send";
  send.textContent = "Comment";
  send.disabled = true;
  row.append(hint, send);
  wrap.append(ta, row);

  const autoGrow = (): void => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    positionComposer();
  };

  // Collapsed to just the input until it is in use: this is a fixed overlay on
  // a scrolling column, so its height is a band of the margin that cannot be
  // clicked without scrolling — and what lands there is Accept / Reject / Reply
  // at the foot of a tall thread.
  const setActive = (on: boolean): void => {
    wrap.classList.toggle("pct-composer-active", on || !!ta.value.trim());
    positionComposer();
  };

  const submit = async (): Promise<void> => {
    const body = ta.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      await postDocComment(body);
      ta.value = "";
      setActive(false);
      autoGrow();
    } catch (e) {
      hint.textContent = `could not post: ${e instanceof Error ? e.message : String(e)}`;
      hint.classList.add("pct-composer-error");
      setTimeout(() => {
        hint.textContent = "whole document";
        hint.classList.remove("pct-composer-error");
      }, 4000);
    } finally {
      send.disabled = !ta.value.trim();
    }
  };

  ta.addEventListener("focus", () => setActive(true));
  ta.addEventListener("blur", () => setActive(false));
  ta.addEventListener("input", () => {
    send.disabled = !ta.value.trim();
    setActive(true);
    autoGrow();
  });
  // Enter sends, Shift+Enter newlines — the chat convention this borrows from.
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });
  send.addEventListener("click", () => void submit());

  document.body.appendChild(wrap);
  return wrap;
}

/* -------------------------------------------------------------------- boot */

let observersBound = false;

function boot(): boolean {
  const root = document.getElementById("root");
  if (!layoutEl() || !root) return false;

  state.side = readStored() ?? 0;
  state.pinned = state.side > 0;

  if (!grip || !grip.isConnected) grip = makeGrip();
  if (!composer || !composer.isConnected) composer = makeComposer();

  applyWidths();
  syncDocPadding();
  positionComposer();

  // No ResizeObserver on <html>: its content box grows with the page and this
  // module writes padding into the page, which closes a write -> resize -> write
  // loop. `resize` covers the pane; the MutationObserver covers React.
  if (!observersBound) {
    observersBound = true;
    new MutationObserver(scheduleSync).observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleSync);
  }
  return true;
}

export function startPercentUi(): void {
  if (boot()) return;
  let tries = 0;
  const t = setInterval(() => {
    if (boot() || ++tries > 100) clearInterval(t);
  }, 50);
}
