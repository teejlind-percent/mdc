/**
 * The comment margin: thread cards aligned to their highlights in the document.
 *
 * Cards are absolutely positioned at their anchor's Y, sorted top-down, and
 * pushed down to avoid overlap. Because a card's height isn't known until it's
 * in the DOM — and a highlight's Y isn't reliable until the doc has laid out —
 * positioning runs after paint and again across two animation frames.
 *
 * The Open view shows live threads anchor-aligned; the Resolved view shows a
 * flat top-down list. The header filter switches between them.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  actionableSuggestion,
  decidedSuggestions,
  type Entry,
  type Suggestion,
  type SuggestionResolution,
} from "../../src/threads.js";
import { findTargetStrict } from "../../src/anchor.js";
import type { DisplayThread, PendingComment } from "./commentData.js";
import type { CommentAnchorY } from "./commentLines.js";
import { fmtTime, resolveEventsByThread } from "./commentData.js";
import { clusterAround, stackTops } from "./cardStack.js";
import { highlightViewportRect, highlightY, scrollToHighlight } from "./render/highlights.js";
import { CommentMenu } from "./CommentMenu.js";
import { DropdownMenu } from "./DropdownMenu.js";
import { CloseIcon, FunnelIcon } from "./icons.js";
import { EmptySidebar } from "./Empty.js";
import {
  shapeSuggestionDiff,
  shouldCollapseSuggestionDiff,
  suggestionDiffLineCounts,
  type DiffPart,
} from "./suggestionDiff.js";

const REPLY_FOLD_THRESHOLD = 3;
const CARD_GAP = 8;

export type SidebarView = "open" | "resolved";
export type ApplySuggestionOutcome = "applied" | "stale" | "error";

// The literal default author token (mirrors DEFAULT_USER in src/identity.ts,
// duplicated because that module pulls in node built-ins the web bundle can't
// take). Comments written before an identity was set are frozen as this token
// in the append-only sidecar, so they stay human even after the user renames
// themselves — otherwise a rename would reclassify every prior comment as agent.
const DEFAULT_USER = "user";

function isHuman(author: string | undefined, user: string): boolean {
  return author === user || author === DEFAULT_USER;
}
function roleClass(author: string | undefined, user: string): "user" | "agent" {
  return isHuman(author, user) ? "user" : "agent";
}
function initials(author: string | undefined, user: string): string {
  if (!author) return "??";
  return isHuman(author, user) ? author.slice(0, 2).toUpperCase() || "??" : "AI";
}

function flowItems(items: HTMLElement[], list: HTMLElement, start = 6): number {
  let cursor = start;
  for (const row of items) {
    row.style.top = `${cursor}px`;
    row.style.visibility = "";
    cursor += row.offsetHeight + CARD_GAP;
  }
  list.style.minHeight = cursor > start ? `${cursor + 40}px` : "";
  return cursor;
}

function stackItems(
  items: HTMLElement[],
  list: HTMLElement,
  start = 6,
  focusId?: string | null,
): number {
  items.sort((a, b) => Number(a.dataset.anchorY ?? 0) - Number(b.dataset.anchorY ?? 0));
  const focusIdx = focusId ? items.findIndex((c) => c.dataset.sidebarId === focusId) : -1;
  const tops = stackTops(
    items.map((c) => ({ anchor: Number(c.dataset.anchorY ?? 0), height: c.offsetHeight })),
    start,
    CARD_GAP,
    focusIdx,
  );
  for (let i = 0; i < items.length; i++) {
    items[i]!.style.top = `${tops[i]}px`;
    items[i]!.style.visibility = "";
  }
  const n = items.length;
  const cursor = n > 0 ? tops[n - 1]! + items[n - 1]!.offsetHeight + CARD_GAP : start;
  list.style.minHeight = cursor > start ? `${cursor + 40}px` : "";
  return cursor;
}

function latestThreadDecision(
  thread: DisplayThread,
  decisions: Map<string, SuggestionResolution>,
): SuggestionResolution | undefined {
  const content = [thread.top, ...thread.replies];
  for (let index = content.length - 1; index >= 0; index--) {
    const decision = decisions.get(content[index]!.id);
    if (decision) return decision;
  }
  return undefined;
}

export function Comments({
  threads,
  entries,
  rawContent,
  orphanIds,
  user,
  overlayRoot,
  hasFile,
  paintTick,
  collapsed,
  view,
  onView,
  pending,
  onSubmitPending,
  onCancelPending,
  onReply,
  onResolve,
  onApplySuggestion,
  onDismissSuggestion,
  replyPrompt,
  onReplyPromptShown,
  onPreviewSuggestion,
  onUnresolve,
  onEdit,
  onRequestDelete,
  onCollapse,
  editing,
  editAnchorYs,
  editorHost,
  onEditModeCardClick,
  onEditModeSuggestionPreview,
}: {
  threads: DisplayThread[];
  entries: Entry[];
  /** Current raw markdown used to preflight actionable suggestion targets. */
  rawContent: string | null;
  /** Top-level ids of open threads whose anchor quote isn't in the current doc. */
  orphanIds: string[];
  user: string;
  /** The highlight overlay element, where the .hl-rect divs live — cards measure
   *  their anchor Y against the rects here. */
  overlayRoot: HTMLElement | null;
  hasFile: boolean;
  /** Bumped by the parent whenever highlights are repainted, so cards re-measure. */
  paintTick: number;
  /** Whether the comment sidebar is collapsed (cards can't be measured while hidden). */
  collapsed: boolean;
  view: SidebarView;
  onView: (view: SidebarView) => void;
  onCollapse: () => void;
  pending: PendingComment | null;
  onSubmitPending: (body: string) => void;
  onCancelPending: () => void;
  onReply: (threadId: string, body: string) => void;
  onResolve: (threadId: string) => void;
  onApplySuggestion: (
    threadId: string,
    suggestionId: string,
    suggestion: Suggestion,
  ) => Promise<ApplySuggestionOutcome>;
  onDismissSuggestion: (threadId: string, suggestionId: string) => Promise<void>;
  replyPrompt: { threadId: string; nonce: number } | null;
  /** One-shot ack: clears the prompt so card remounts can't re-fire it. */
  onReplyPromptShown: () => void;
  onPreviewSuggestion: (threadId: string, suggestionId: string, suggestion: Suggestion) => void;
  onUnresolve: (threadId: string) => void;
  onEdit: (commentId: string, body: string) => void;
  onRequestDelete: (commentId: string) => void;
  /** Edit mode is active for this file. */
  editing: boolean;
  /** Live editor anchor positions, relative to the editor host's top edge. */
  editAnchorYs?: CommentAnchorY[];
  /** The editor's scroll container — anchor offsets are re-based against its
   *  live position at layout time, so they stay valid across page scrolls. */
  editorHost?: HTMLElement | null;
  onEditModeCardClick?: (commentId: string) => void;
  onEditModeSuggestionPreview?: (threadId: string, suggestionId: string, suggestion: Suggestion) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [resizeTick, setResizeTick] = useState(0);
  // Bumped by a card when its height changes in place (reply form open/close,
  // replies expand/collapse, textarea autogrow) so the cards below re-flow.
  const [layoutTick, setLayoutTick] = useState(0);
  // The card the user is working in. It gets pinned to its own anchor and the
  // rest of the stack moves around it, so a reply box never drags the document
  // away from the text it is about. A stale id (file switched, thread resolved)
  // is simply not found at layout time and the stack falls back to packing
  // downward, so it needs no explicit teardown.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Ids condensed to a one-line summary because they crowd the active card.
  // Google Docs does this: when you open one comment in a cluster, its
  // neighbours get out of the way rather than pushing it off its anchor.
  const [condensedIds, setCondensedIds] = useState<ReadonlySet<string>>(new Set());
  const reposition = useRef(() => setLayoutTick((t) => t + 1)).current;
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const orphanSet = new Set(orphanIds);
  const decisions = decidedSuggestions(entries);

  // A new selection means the user is done with whatever card was pinned; the
  // composer is the thing that now needs to sit at its anchor.
  useEffect(() => {
    if (pending) setActiveId(null);
  }, [pending]);

  useEffect(() => {
    if (!activeId) setCondensedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [activeId]);

  // Don't strand the user in an empty Resolved view (e.g. they just unresolved
  // the last one) — fall back to Open.
  const effectiveView: SidebarView = view === "resolved" && resolved.length === 0 ? "open" : view;

  // Position absolute cards against live anchor Ys (rendered highlights in view
  // mode, editor line geometry in edit mode). Resolved rows flow top-down.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // While collapsed the panel is display:none — measuring would read zeros and
    // stack every card at the top. Skip; the reopen effect re-places once visible.
    if (collapsed) return;

    // Which cards are crowding the active one. Anchors only — see clusterAround.
    const syncCondensed = (cards: HTMLElement[]) => {
      if (!activeId) return;
      const sorted = [...cards].sort(
        (a, b) => Number(a.dataset.anchorY ?? 0) - Number(b.dataset.anchorY ?? 0),
      );
      const focusIdx = sorted.findIndex((c) => c.dataset.sidebarId === activeId);
      if (focusIdx < 0) return;
      const anchors = sorted.map((c) => Number(c.dataset.anchorY ?? 0));
      const next = new Set(
        clusterAround(anchors, focusIdx)
          .filter((i) => i !== focusIdx)
          .map((i) => sorted[i]!.dataset.sidebarId!)
          .filter(Boolean),
      );
      setCondensedIds((prev) => {
        if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    };

    const place = () => {
      const items = Array.from(list.querySelectorAll<HTMLElement>(".comment, .resolved-item"));
      const start = 6;
      let cursor = start;
      // Edit mode: run the same sorted non-overlap stack as rendered view mode,
      // from the editor-reported host-relative anchor offsets re-based against
      // the host's position NOW (same-frame with the list's — scroll-proof).
      // A card without an editor anchor (quote not matchable in raw markdown —
      // which includes but isn't limited to orphans) flows below the stack.
      if (editing) {
        if (!editorHost) {
          flowItems(items, list, start);
          return;
        }
        const listRect = list.getBoundingClientRect();
        const hostTop = editorHost.getBoundingClientRect().top - listRect.top + list.scrollTop;
        const anchors = new Map((editAnchorYs ?? []).map((anchor) => [anchor.commentId, anchor.y]));
        const positioned: HTMLElement[] = [];
        const unpositioned: HTMLElement[] = [];
        for (const card of items) {
          const id = card.dataset.sidebarId;
          const y = id ? anchors.get(id) : undefined;
          if (y === undefined) {
            // No fresh editor anchor. Keep the last known position (same rule
            // as view mode's orphaned-mid-session case) — a pinned suggestion
            // preview replaces its own quote in the buffer, and its card must
            // not fall to the bottom for the duration of the pin. Only cards
            // that never had an anchor (true orphans) flow below the stack.
            if (card.dataset.anchorY !== undefined) positioned.push(card);
            else unpositioned.push(card);
            continue;
          }
          card.dataset.anchorY = String(hostTop + y);
          positioned.push(card);
        }
        syncCondensed(positioned);
        cursor = stackItems(positioned, list, start, activeId);
        if (unpositioned.length > 0) flowItems(unpositioned, list, cursor);
        return;
      }
      // Resolved rows flow top-down (no anchor alignment).
      if (effectiveView === "resolved") {
        flowItems(items, list, start);
        return;
      }
      // Open view: re-derive each card's anchor Y from its live highlight; keep
      // the last known value if the highlight isn't found (orphaned mid-session).
      if (overlayRoot) {
        for (const card of items) {
          const id = card.dataset.sidebarId;
          if (!id) continue;
          const y = highlightY(overlayRoot, id, list);
          if (y !== null) card.dataset.anchorY = String(y);
        }
      }
      const anchored = items.filter((card) => !card.classList.contains("is-orphaned"));
      const orphaned = items.filter((card) => card.classList.contains("is-orphaned"));
      syncCondensed(anchored);
      cursor = stackItems(anchored, list, start, activeId);
      if (orphaned.length > 0) flowItems(orphaned, list, cursor);
    };

    place();
    const r1 = requestAnimationFrame(() => {
      place();
      requestAnimationFrame(() => {
        place();
        // Cards slide when the stack re-forms around a newly pinned card, which
        // is how you see what moved. Armed only after the first placement has
        // settled — animating the initial 0 → anchor jump would be a visible
        // flash of every card flying down the column on load.
        list.dataset.placed = "1";
      });
    });
    // No scroll listener: the sidebar grows with the page and scrolls natively,
    // so once placed a card translates in lockstep with the doc.
    return () => cancelAnimationFrame(r1);
  }, [open, resolved, effectiveView, overlayRoot, paintTick, resizeTick, layoutTick, pending, collapsed, editing, editAnchorYs, editorHost, activeId]);

  // Pinning a card puts it beside its anchor, but on a short pane a tall card
  // can still hang below the fold — and the browser's own focus scroll (now
  // suppressed) used to "fix" that by scrolling the anchor off the top, which
  // is the whole complaint. So scroll deliberately instead, and only as far as
  // it takes to get the card AND its text on screen together. The anchor wins
  // when both cannot fit: reading the passage matters more than seeing the
  // whole card, which the user can scroll to themselves.
  // Re-checked on every relayout of the active card, not just on activation:
  // opening the reply form grows the card AFTER it is pinned, and a check that
  // ran only once fired while the card was still short and concluded, wrongly,
  // that it already fitted. A cooldown keeps a smooth scroll from being
  // measured mid-flight and doubled.
  const lastScrollAt = useRef(0);
  useEffect(() => {
    if (!activeId) return;
    const list = listRef.current;
    if (!list || !overlayRoot) return;
    const raf = requestAnimationFrame(() => {
      const card = list.querySelector<HTMLElement>(
        `.comment[data-sidebar-id="${CSS.escape(activeId)}"]`,
      );
      const anchor = highlightViewportRect(overlayRoot, activeId);
      if (!card || !anchor) return;
      const cardRect = card.getBoundingClientRect();
      const viewH = window.innerHeight || document.documentElement.clientHeight;
      const margin = Math.min(24, viewH * 0.06);
      const top = Math.min(cardRect.top, anchor.top);
      const bottom = Math.max(cardRect.bottom, anchor.bottom);

      let delta = 0;
      if (bottom - top > viewH - margin * 2) {
        // Can't show both. Put the anchor near the top and let the card run on.
        delta = anchor.top - margin;
      } else if (top < margin) {
        delta = top - margin;
      } else if (bottom > viewH - margin) {
        delta = bottom - (viewH - margin);
      }
      if (Math.abs(delta) < 2) return;
      const now = performance.now();
      if (now - lastScrollAt.current < 500) return;
      lastScrollAt.current = now;
      window.scrollBy({ top: delta, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId, overlayRoot, layoutTick]);

  // Reposition on window resize (anchor Ys shift with wrap width).
  useLayoutEffect(() => {
    const onResize = () => setResizeTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // While collapsed the cards can't be measured. On reopen the doc column also
  // widens (the grid animates over 150ms), shifting every highlight's Y — so the
  // cards' pre-collapse positions are stale. Hide the list until the transition
  // settles, then re-measure once, so cards appear directly at the right spot
  // instead of flashing at a mid-animation position.
  const prevCollapsed = useRef(collapsed);
  useEffect(() => {
    const reopened = prevCollapsed.current && !collapsed;
    prevCollapsed.current = collapsed;
    if (!reopened) return;
    // The doc column rewraps as the grid animates back (~150ms), shifting every
    // highlight's Y. Rather than blank the panel and wait, re-place each frame
    // for the transition's duration so cards slide into place with the reflowing
    // doc — visible the whole time, no flash, no empty pause.
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      setResizeTick((t) => t + 1);
      if (performance.now() - start < 220) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [collapsed]);

  const empty =
    effectiveView === "open"
      ? open.length === 0 && !pending
      : resolved.length === 0;

  return (
    <>
      <SidebarHeader
        view={effectiveView}
        hasResolved={resolved.length > 0}
        onView={onView}
        onCollapse={onCollapse}
      />
      {empty ? (
        <EmptySidebar hasFile={hasFile} />
      ) : (
        <div className="comment-list" ref={listRef}>
          {effectiveView === "resolved"
            ? resolved.map((t) => (
                <ResolvedItem
                  key={t.top.id}
                  thread={t}
                  events={resolveEventsByThread(entries)}
                  decision={latestThreadDecision(t, decisions)}
                  onUnresolve={onUnresolve}
                />
              ))
            : open.map((t) => (
                <ThreadCard
                  key={t.top.id}
                  thread={t}
                  user={user}
                  overlayRoot={editing ? null : overlayRoot}
                  onReply={onReply}
                  onResolve={onResolve}
                  onApplySuggestion={onApplySuggestion}
                  onDismissSuggestion={onDismissSuggestion}
                  replyPromptNonce={
                    replyPrompt?.threadId === t.top.id ? replyPrompt.nonce : undefined
                  }
                  onReplyPromptShown={onReplyPromptShown}
                  onPreviewSuggestion={editing ? undefined : onPreviewSuggestion}
                  onEdit={onEdit}
                  onRequestDelete={onRequestDelete}
                  reposition={reposition}
                  orphaned={orphanSet.has(t.top.id)}
                  decisions={decisions}
                  actionable={actionableSuggestion(entries, t.top.id)}
                  rawContent={rawContent}
                  active={activeId === t.top.id}
                  condensed={condensedIds.has(t.top.id)}
                  onActivate={setActiveId}
                  onEditModeClick={editing ? onEditModeCardClick : undefined}
                  onEditModeSuggestionPreview={editing ? onEditModeSuggestionPreview : undefined}
                />
              ))}
          {effectiveView === "open" && !editing && pending && (
            <PendingCard
              pending={pending}
              user={user}
              reposition={reposition}
              onSubmit={onSubmitPending}
              onCancel={onCancelPending}
            />
          )}
        </div>
      )}
    </>
  );
}

/** The Open/Resolved filter, in the sidebar header. */
function SidebarHeader({
  view,
  hasResolved,
  onView,
  onCollapse,
}: {
  view: SidebarView;
  hasResolved: boolean;
  onView: (view: SidebarView) => void;
  onCollapse: () => void;
}) {
  const pick = (v: SidebarView, close: () => void) => {
    close();
    if (v !== view) onView(v);
  };

  return (
    <div className="sidebar-header">
      <DropdownMenu
        wrapClassName="sidebar-filter-wrap"
        triggerClassName={(open) =>
          `sidebar-filter-btn${view === "resolved" ? " is-filtered" : ""}${open ? " is-open" : ""}`
        }
        triggerTitle={view === "resolved" ? "Filter: Resolved" : "Filter: Open"}
        triggerAriaLabel="Filter comments"
        triggerChildren={<FunnelIcon />}
        menuClassName="sidebar-filter-menu"
      >
        {(close) => (
          <>
            <FilterOption
              label="Open"
              active={view === "open"}
              onClick={() => pick("open", close)}
            />
            <FilterOption
              label="Resolved"
              active={view === "resolved"}
              disabled={!hasResolved}
              onClick={() => pick("resolved", close)}
            />
          </>
        )}
      </DropdownMenu>
      <button
        type="button"
        className="sidebar-close-btn"
        title="Hide comments (⌘⇧\)"
        aria-label="Hide comments"
        onClick={onCollapse}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function FilterOption({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={disabled}
      className={active ? "active" : ""}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="sidebar-filter-check">{active ? "✓" : ""}</span>
      <span>{label}</span>
    </button>
  );
}

function PendingCard({
  pending,
  user,
  reposition,
  onSubmit,
  onCancel,
}: {
  pending: PendingComment;
  user: string;
  reposition: () => void;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // preventScroll: the card is positioned against its anchor; letting the
    // browser scroll to the textarea instead drags the document off the text.
    taRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      className={`comment pending ${roleClass(user, user)}`}
      data-sidebar-id="pending"
      data-anchor-y={pending.anchorY}
      style={{ position: "absolute", left: 8, right: 20, top: 0, visibility: "hidden" }}
    >
      <div className="hdr">
        <span className={`avatar ${roleClass(user, user)}`}>{initials(user, user)}</span>
        <span className="author">{user}</span>
        <span className="time">new</span>
      </div>
      <form
        className="new-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(body.trim());
        }}
      >
        <textarea
          ref={taRef}
          placeholder="Comment..."
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            autogrow(e.target);
            reposition();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onSubmit(body.trim());
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
        />
        <div className="btns">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit">Comment</button>
        </div>
      </form>
    </div>
  );
}

function ThreadCard({
  thread,
  user,
  overlayRoot,
  onReply,
  onResolve,
  onApplySuggestion,
  onDismissSuggestion,
  replyPromptNonce,
  onReplyPromptShown,
  onPreviewSuggestion,
  onEdit,
  onRequestDelete,
  reposition,
  orphaned,
  decisions,
  actionable,
  rawContent,
  active,
  condensed,
  onActivate,
  onEditModeClick,
  onEditModeSuggestionPreview,
}: {
  thread: DisplayThread;
  user: string;
  overlayRoot: HTMLElement | null;
  onReply: (threadId: string, body: string) => void;
  onResolve: (threadId: string) => void;
  onApplySuggestion: (
    threadId: string,
    suggestionId: string,
    suggestion: Suggestion,
  ) => Promise<ApplySuggestionOutcome>;
  onDismissSuggestion: (threadId: string, suggestionId: string) => Promise<void>;
  replyPromptNonce?: number;
  onReplyPromptShown: () => void;
  onPreviewSuggestion?: (threadId: string, suggestionId: string, suggestion: Suggestion) => void;
  onEdit: (commentId: string, body: string) => void;
  onRequestDelete: (commentId: string) => void;
  reposition: () => void;
  orphaned: boolean;
  decisions: Map<string, "applied" | "dismissed">;
  actionable: Entry | undefined;
  rawContent: string | null;
  /** This card is pinned to its anchor; the rest of the stack moves around it. */
  active: boolean;
  /** Crowding the active card — shown as a one-line summary until clicked. */
  condensed: boolean;
  onActivate: (commentId: string) => void;
  onEditModeClick?: (commentId: string) => void;
  onEditModeSuggestionPreview?: (threadId: string, suggestionId: string, suggestion: Suggestion) => void;
}) {
  const { top, replies } = thread;
  const foldable = replies.length > REPLY_FOLD_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [reasonPrompt, setReasonPrompt] = useState(false);
  const [editing, setEditing] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [staleSuggestionId, setStaleSuggestionId] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Re-flow the cards below whenever this card's height changes in place.
  useEffect(() => reposition(), [expanded, replying, editing, reposition]);

  useEffect(() => {
    if (replying) replyRef.current?.focus({ preventScroll: true });
  }, [replying]);

  useEffect(() => {
    if (replyPromptNonce === undefined) return;
    setReasonPrompt(true);
    setReplying(true);
    replyRef.current?.focus({ preventScroll: true });
    onReplyPromptShown();
  }, [replyPromptNonce, onReplyPromptShown]);

  const showReplies = !foldable || expanded;
  const actionableSuggestionId = actionable?.id;
  const targetStale =
    actionable?.suggestion !== undefined &&
    rawContent !== null &&
    findTargetStrict(actionable.suggestion.target, rawContent) === null;
  const decisionBlocked =
    targetStale ||
    (actionableSuggestionId !== undefined && staleSuggestionId === actionableSuggestionId);
  const previewSuggestion =
    onPreviewSuggestion &&
    !orphaned &&
    !decisionBlocked &&
    actionable?.suggestion &&
    actionableSuggestionId
      ? () => onPreviewSuggestion(top.id, actionableSuggestionId, actionable.suggestion!)
      : undefined;
  // Edit mode pins the inline merge chunk instead of the doc preview, so the
  // collapsed card's Preview in doc affordance works in both modes.
  const editPreviewSuggestion =
    onEditModeSuggestionPreview &&
    !orphaned &&
    !decisionBlocked &&
    actionable?.suggestion &&
    actionableSuggestionId
      ? () => onEditModeSuggestionPreview(top.id, actionableSuggestionId, actionable.suggestion!)
      : undefined;
  const pinPreview = previewSuggestion ?? editPreviewSuggestion;

  const acceptSuggestion = async (suggestionId: string, suggestion: Suggestion) => {
    setApplyingId(suggestionId);
    const outcome = await onApplySuggestion(top.id, suggestionId, suggestion);
    if (outcome === "stale") setStaleSuggestionId(suggestionId);
    setApplyingId(null);
  };

  const dismissSuggestion = async (suggestionId: string) => {
    setDismissingId(suggestionId);
    try {
      await onDismissSuggestion(top.id, suggestionId);
    } finally {
      setDismissingId(null);
    }
  };

  const submitReply = () => {
    const body = replyBody.trim();
    if (!body) return;
    onReply(top.id, body);
    setReplyBody("");
    setReasonPrompt(false);
    setReplying(false);
  };

  return (
    <div
      className={`comment ${roleClass(top.author, user)}${orphaned ? " is-orphaned" : ""}${active ? " is-active" : ""}${condensed ? " is-condensed" : ""}`}
      data-sidebar-id={top.id}
      style={{ position: "absolute", left: 8, right: 20, top: 0, visibility: "hidden" }}
      title="Click to jump to highlighted text"
      // Capture, and on pointerdown: the pin has to be in place BEFORE the
      // browser focuses a reply textarea, or it scrolls to the card's old
      // position first and the fix arrives a frame too late.
      onPointerDownCapture={() => onActivate(top.id)}
      onFocusCapture={() => onActivate(top.id)}
      onClick={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || tag === "INPUT") return;
        if ((e.target as HTMLElement).closest("form")) return;
        previewSuggestion?.();
        if (overlayRoot) scrollToHighlight(overlayRoot, top.id);
        else {
          onEditModeClick?.(top.id);
          if (
            onEditModeSuggestionPreview &&
            actionable?.suggestion &&
            actionableSuggestionId &&
            !decisionBlocked
          ) {
            onEditModeSuggestionPreview(top.id, actionableSuggestionId, actionable.suggestion);
          }
        }
      }}
    >
      {condensed ? (
        // One line: who, and enough of the body to recognise the thread. The
        // whole row is the click target — activating it expands this card and
        // condenses whichever one was active, so a cluster only ever has one
        // card open at a time.
        <div className="condensed-row" title={top.body}>
          <span className={`avatar ${roleClass(top.author, user)}`}>
            {initials(top.author, user)}
          </span>
          <span className="condensed-body">{top.body}</span>
          {replies.length > 0 && <span className="condensed-count">{replies.length + 1}</span>}
        </div>
      ) : (
      <>
      <div className="hdr">
        <span className={`avatar ${roleClass(top.author, user)}`}>{initials(top.author, user)}</span>
        <span className="author">{top.author}</span>
        <span className="time">{fmtTime(top.timestamp)}</span>
        {orphaned && <span className="comment-orphan-tag">orphaned</span>}
        {!top.deleted && (
          <>
            <button
              className="resolve-btn"
              title="Resolve thread"
              aria-label="Resolve thread"
              onClick={(e) => {
                e.stopPropagation();
                onResolve(top.id);
              }}
            >
              <CheckIcon />
            </button>
            <CommentMenu onEdit={() => setEditing(true)} onDelete={() => onRequestDelete(top.id)} />
          </>
        )}
      </div>
      {editing ? (
        <EditForm
          initial={top.body}
          onSave={(b) => {
            onEdit(top.id, b);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          reposition={reposition}
        />
      ) : (
        <div className={`body${top.deleted ? " deleted" : ""}`}>{top.body}</div>
      )}
      {!top.deleted && top.suggestion && (
        <SuggestionBlock
          suggestion={top.suggestion}
          superseded={!decisions.has(top.id) && top.id !== actionableSuggestionId}
          decision={decisions.get(top.id)}
          onAccept={
            top.id === actionableSuggestionId && !decisionBlocked
              ? () => acceptSuggestion(top.id, top.suggestion!)
              : undefined
          }
          onReject={
            top.id === actionableSuggestionId ? () => dismissSuggestion(top.id) : undefined
          }
          onPreview={top.id === actionableSuggestionId ? pinPreview : undefined}
          blocked={top.id === actionableSuggestionId && decisionBlocked}
          accepting={applyingId === top.id}
          rejecting={dismissingId === top.id}
        />
      )}

      {(showReplies || foldable) && (
        <div className="replies">
          {showReplies &&
            replies.map((r) => (
              <Reply
                key={r.id}
                reply={r}
                user={user}
                onEdit={onEdit}
                onRequestDelete={onRequestDelete}
                reposition={reposition}
                superseded={
                  r.suggestion !== undefined &&
                  !decisions.has(r.id) &&
                  r.id !== actionableSuggestionId
                }
                decision={decisions.get(r.id)}
                onAccept={
                  r.id === actionableSuggestionId && !decisionBlocked
                    ? () => acceptSuggestion(r.id, r.suggestion!)
                    : undefined
                }
                onReject={
                  r.id === actionableSuggestionId ? () => dismissSuggestion(r.id) : undefined
                }
                onPreview={r.id === actionableSuggestionId ? pinPreview : undefined}
                blocked={r.id === actionableSuggestionId && decisionBlocked}
                accepting={applyingId === r.id}
                rejecting={dismissingId === r.id}
              />
            ))}
          {foldable && (
            <button
              type="button"
              className="replies-toggle"
              onClick={() => setExpanded((x) => !x)}
            >
              {expanded ? "Hide replies" : `${replies.length} replies`}
            </button>
          )}
        </div>
      )}

      {replying ? (
        <form
          className="reply-form active"
          onBlur={(event) => {
            if (
              reasonPrompt &&
              !replyBody.trim() &&
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setReasonPrompt(false);
              setReplying(false);
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            submitReply();
          }}
        >
          <textarea
            ref={replyRef}
            placeholder={
              reasonPrompt ? "Why? (optional — helps the agent revise)" : "Write a reply..."
            }
            value={replyBody}
            onChange={(e) => {
              setReplyBody(e.target.value);
              autogrow(e.target);
              reposition();
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submitReply();
              } else if (e.key === "Escape") {
                setReasonPrompt(false);
                setReplying(false);
                setReplyBody("");
              }
            }}
          />
          <div className="btns">
            <button
              type="button"
              onClick={() => {
                setReasonPrompt(false);
                setReplying(false);
                setReplyBody("");
              }}
            >
              Cancel
            </button>
            <button type="submit">Comment</button>
          </div>
        </form>
      ) : (
        <div className="reply-row">
          <button
            type="button"
            className="reply-btn"
            onClick={() => {
              setReasonPrompt(false);
              setReplying(true);
            }}
          >
            Reply
          </button>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function Reply({
  reply,
  user,
  onEdit,
  onRequestDelete,
  reposition,
  superseded,
  decision,
  onAccept,
  onReject,
  onPreview,
  accepting,
  rejecting,
  blocked,
}: {
  reply: DisplayThread["replies"][number];
  user: string;
  onEdit: (commentId: string, body: string) => void;
  onRequestDelete: (commentId: string) => void;
  reposition: () => void;
  superseded: boolean;
  decision?: SuggestionResolution;
  onAccept?: () => void;
  onReject?: () => void;
  onPreview?: () => void;
  accepting: boolean;
  rejecting: boolean;
  blocked: boolean;
}) {
  const [editing, setEditing] = useState(false);
  useEffect(() => reposition(), [editing, reposition]);

  return (
    <div className={`reply ${roleClass(reply.author, user)}`}>
      <div className="hdr">
        <span className={`avatar ${roleClass(reply.author, user)}`}>
          {initials(reply.author, user)}
        </span>
        <span className="author">{reply.author}</span>
        <span className="time">{fmtTime(reply.timestamp)}</span>
        <CommentMenu onEdit={() => setEditing(true)} onDelete={() => onRequestDelete(reply.id)} />
      </div>
      {editing ? (
        <EditForm
          initial={reply.body}
          onSave={(b) => {
            onEdit(reply.id, b);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          reposition={reposition}
        />
      ) : (
        <div className="body">{reply.body}</div>
      )}
      {reply.suggestion && (
        <SuggestionBlock
          suggestion={reply.suggestion}
          superseded={superseded}
          decision={decision}
          onAccept={onAccept}
          onReject={onReject}
          onPreview={onPreview}
          blocked={blocked}
          accepting={accepting}
          rejecting={rejecting}
        />
      )}
    </div>
  );
}

function DiffText({ parts, kind }: { parts: DiffPart[]; kind: "add" | "del" }) {
  return parts.map((part, index) =>
    part.changed ? (
      <mark className={`suggestion-change ${kind}`} key={index}>
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

function SuggestionBlock({
  suggestion,
  superseded,
  decision,
  onAccept,
  onReject,
  onPreview,
  accepting = false,
  rejecting = false,
  blocked = false,
}: {
  suggestion: Suggestion;
  superseded: boolean;
  decision?: SuggestionResolution;
  onAccept?: () => void;
  onReject?: () => void;
  onPreview?: () => void;
  accepting?: boolean;
  rejecting?: boolean;
  /** The target span no longer matches the document, so Accept cannot run. */
  blocked?: boolean;
}) {
  const diff = shapeSuggestionDiff(suggestion.target.quote, suggestion.replacement);
  const lineCounts = suggestionDiffLineCounts(suggestion.target.quote, suggestion.replacement);
  const collapsed = onPreview !== undefined && shouldCollapseSuggestionDiff(
    suggestion.target.quote,
    suggestion.replacement,
  );
  return (
    <div
      className={`suggestion-block${superseded ? " is-superseded" : ""}`}
      aria-label={superseded ? "Superseded suggestion diff" : "Suggestion diff"}
    >
      <div className="suggestion-heading">
        <span>Suggestion</span>
        {decision ? (
          <span className="suggestion-decision-chip">
            {decision === "applied" ? "Applied" : "Dismissed"}
          </span>
        ) : superseded ? (
          <span className="suggestion-state">superseded</span>
        ) : null}
      </div>
      {collapsed ? (
        <div className="suggestion-collapsed">
          <span className="suggestion-summary" aria-label="Suggestion line changes">
            +{lineCounts.added} −{lineCounts.removed}
          </span>
          <button
            className="suggestion-preview-btn"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPreview();
            }}
          >
            Preview in doc
          </button>
        </div>
      ) : (
        <>
          <div className="suggestion-side current">
            <div className="suggestion-label">Current</div>
            <div className="suggestion-text">
              <DiffText parts={diff.current} kind="del" />
            </div>
          </div>
          <div className="suggestion-side proposed">
            <div className="suggestion-label">Proposed</div>
            <div className="suggestion-text">
              {suggestion.replacement === "" ? (
                <span className="suggestion-deleted">(deleted)</span>
              ) : (
                <DiffText parts={diff.proposed} kind="add" />
              )}
            </div>
          </div>
        </>
      )}
      {/* A stale target used to remove the Accept button and say nothing, which
          read as the button randomly disappearing — you edit a word inside the
          block a suggestion covers (or within ~40 characters either side of
          it) and Accept is silently gone, with Reject still sitting there
          looking healthy. Refusing to apply is right; applying a replacement
          whose target has moved would corrupt the document. Being quiet about
          it is not. */}
      {blocked && (
        <div className="suggestion-blocked" role="status">
          Can’t apply — the text this targets has changed. Ask for the
          suggestion again against the current wording, or Reject it.
        </div>
      )}
      {(onAccept || onReject) && (
        <div className="suggestion-actions">
          {onReject && (
            <button
              className="suggestion-reject"
              type="button"
              onClick={onReject}
              disabled={accepting || rejecting}
            >
              {rejecting ? "Dismissing…" : "Reject"}
            </button>
          )}
          {onAccept && (
            <button type="button" onClick={onAccept} disabled={accepting || rejecting}>
              {accepting ? "Applying…" : "Accept"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline edit composer — prefilled, ⌘↵ saves, Esc cancels, unchanged is a no-op. */
function EditForm({
  initial,
  onSave,
  onCancel,
  reposition,
}: {
  initial: string;
  onSave: (body: string) => void;
  onCancel: () => void;
  reposition: () => void;
}) {
  const [body, setBody] = useState(initial);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.focus({ preventScroll: true });
      autogrow(ta);
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, []);

  const save = () => {
    const next = body.trim();
    if (!next || next === initial) onCancel(); // no-op on empty/unchanged
    else onSave(next);
  };

  return (
    <form
      className="edit-form active"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        ref={taRef}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          autogrow(e.target);
          reposition();
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="btns">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit">Save</button>
      </div>
    </form>
  );
}

function ResolvedItem({
  thread,
  events,
  decision,
  onUnresolve,
}: {
  thread: DisplayThread;
  events: Map<string, Entry>;
  decision?: SuggestionResolution;
  onUnresolve: (threadId: string) => void;
}) {
  const ev = events.get(thread.top.id);
  const outcome =
    ev?.resolution === "applied" || ev?.resolution === "dismissed"
      ? ev.resolution
      : decision;
  const quote = ev?.anchor_snapshot?.quote ?? thread.top.anchor?.quote ?? "";
  const by = ev?.author ? `resolved by ${ev.author}` : "resolved";
  const when = ev?.timestamp ? ` · ${fmtTime(ev.timestamp)}` : "";

  return (
    <div
      className="resolved-item"
      data-sidebar-id={thread.top.id}
      style={{ position: "absolute", left: 8, right: 20, top: 0, visibility: "hidden" }}
    >
      {quote && <div className="resolved-quote">{quote}</div>}
      <div className="resolved-body">{thread.top.body}</div>
      <div className="resolved-meta">
        <span className="resolved-by">
          {by}
          {when}
        </span>
        {outcome && (
          <span className="suggestion-decision-chip">
            {outcome === "applied" ? "Applied" : "Dismissed"}
          </span>
        )}
        <button
          className="resolved-unbtn"
          type="button"
          onClick={() => onUnresolve(thread.top.id)}
        >
          Unresolve
        </button>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function autogrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}
