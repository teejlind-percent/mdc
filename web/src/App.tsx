/**
 * App frame — the three-column shell (file nav | document | comments).
 *
 * Owns the cross-cutting chrome state: which side panels are collapsed, the open
 * tabs, the ⌘K jump modal, live state (SSE reload, presence), and the review
 * dashboard. The document fills the centre column and the comment cards the right.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  ApiError,
  createFile,
  createFolder,
  deleteFile,
  deleteFolder,
  deleteSidecar,
  deleteThreadInFile,
  fetchDoc,
  fetchDrawing,
  fetchFolderSummary,
  fetchHtmlFile,
  fetchMovePreview,
  moveFile,
  postApplySuggestion,
  postComment,
  type MovePreview,
  postDelete,
  postDismissSuggestion,
  postEdit,
  postHandoffDone,
  postResolve,
  postResolveOrphans,
  postUnresolve,
  type NewAnchor,
} from "./api.js";
import { CmdK } from "./CmdK.js";
import { Comments, type SidebarView } from "./Comments.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import type { PendingComment } from "./commentData.js";
import { absolutePath, byteSize, filename, formatSize, offersCopyContents } from "./copyTargets.js";
import { actionableSuggestion, type Suggestion } from "../../src/threads.js";
import { findTargetStrict } from "../../src/anchor.js";
import { Doc, type SuggestionPreviewRequest } from "./Doc.js";
import { Settings } from "./Settings.js";
import { DocBanner } from "./DocBanner.js";
import { DocToolbar } from "./DocToolbar.js";
import { Editor, type EditorHandle } from "./Editor.js";
import { HtmlSurface } from "./HtmlSurface.js";
import { ImageView } from "./ImageView.js";
import { PdfView } from "./PdfView.js";
import { resolveCommentLines, type CommentAnchorY } from "./commentLines.js";
import { workspaceRootName } from "./fileTree.js";
import { combo, matchEvent } from "./keymap.js";
import { Nav } from "./Nav.js";
import { computeAnchorContext, enclosingBlockText, renderedOffsetOf, resolveLine } from "./render/createAnchor.js";
import { applyPreviewHighlight, clearPreviewHighlight } from "./render/selection.js";
import { Toast } from "./Toast.js";
import { useActiveFile } from "./useActiveFile.js";
import { useComments } from "./useComments.js";
import { useDashboard } from "./useDashboard.js";
import { useIndex } from "./useIndex.js";
import { useDocScroll } from "./useDocScroll.js";
import { useLiveReload } from "./useLiveReload.js";
import { usePane } from "./usePane.js";
import { usePanels } from "./usePanels.js";
import { usePresence } from "./usePresence.js";
import { useTabs } from "./useTabs.js";
import { useToast } from "./useToast.js";

const ExcalidrawView = lazy(() =>
  import("./ExcalidrawView.js").then((module) => ({ default: module.ExcalidrawView })),
);

type CardFocus = { threadId: string; view: SidebarView; nonce: number; scroll: boolean };
// A nonce re-opens the same card for a later dismissal without making a
// cancelled composer spring back on every render. One-shot: the card clears
// it once shown, so remounts (sidebar-view or mode switches) can't re-fire it.
type ReplyPrompt = { threadId: string; nonce: number };

export function App() {
  const [activeFile, setActiveFile] = useActiveFile();
  const { index, reload: reloadIndex } = useIndex();
  const panels = usePanels();
  const pane = usePane();
  // Memoized by CONTENT (the joined path list), not by `index` identity — a live
  // index reload (e.g. refreshed open-thread counts after a sidecar change)
  // returns a fresh object with the same files, and `paths` must stay a stable
  // reference so the doc-injection effect (keyed on it) doesn't re-run and wipe
  // the painted highlights. See the React-vs-mutated-DOM gotcha.
  const pathKey = (index?.files ?? []).map((f) => f.path).join("\n");
  const paths = useMemo(() => (pathKey ? pathKey.split("\n") : []), [pathKey]);
  // Directory list, memoized by content so empty folders render in the tree
  // without re-firing path-keyed effects on unrelated index reloads.
  const dirKey = (index?.dirs ?? []).join("\n");
  const dirs = useMemo(() => (dirKey ? dirKey.split("\n") : []), [dirKey]);
  // Image files travel a SEPARATE channel from `paths`. `paths` stays md-only —
  // it feeds comment/anchor/wikilink resolution, all markdown-specific. Images
  // join only `openablePaths`, the set for surfaces where "any openable file" is
  // right: the file tree, tabs (so an open image survives reload), and ⌘K.
  const imageKey = (index?.images ?? []).join("\n");
  const images = useMemo(() => (imageKey ? imageKey.split("\n") : []), [imageKey]);
  // HTML files travel the same separate channel as images (openable, not
  // commentable) — rendered in a sandboxed iframe rather than a standalone image.
  const htmlKey = (index?.htmls ?? []).join("\n");
  const htmls = useMemo(() => (htmlKey ? htmlKey.split("\n") : []), [htmlKey]);
  // PDF files also stay separate from markdown: openable, view-only, not
  // commentable.
  const pdfKey = (index?.pdfs ?? []).join("\n");
  const pdfs = useMemo(() => (pdfKey ? pdfKey.split("\n") : []), [pdfKey]);
  // Drawings are lazy-rendered and stay outside markdown-specific flows.
  const drawingKey = (index?.drawings ?? []).join("\n");
  const drawings = useMemo(() => (drawingKey ? drawingKey.split("\n") : []), [drawingKey]);
  const openablePaths = useMemo(
    () => [...paths, ...images, ...htmls, ...pdfs, ...drawings],
    [paths, images, htmls, pdfs, drawings],
  );
  const isImage = useCallback((file: string | null) => !!file && images.includes(file), [images]);
  const isHtml = useCallback((file: string | null) => !!file && htmls.includes(file), [htmls]);
  const isPdf = useCallback((file: string | null) => !!file && pdfs.includes(file), [pdfs]);
  const isDrawing = useCallback(
    (file: string | null) => !!file && drawings.includes(file),
    [drawings],
  );
  // A non-markdown openable file — suppresses the md-only chrome.
  const isNonMd = useCallback(
    (file: string | null) => isImage(file) || isHtml(file) || isPdf(file) || isDrawing(file),
    [isImage, isHtml, isPdf, isDrawing],
  );
  // The index resolves each openable file's type. Until it loads, the
  // type is unknown — treat a deep-linked file as "type pending" so we don't
  // briefly render it as a doc (which would fire 404 /api/md + /api/comments for
  // a non-md file before the index arrives to correct the routing).
  const typeKnown = index !== null;
  // Rendered non-markdown surfaces have no text anchors, so comments stay
  // unavailable even if the user's persisted sidebar preference is open.
  const commentsUnavailable = typeKnown && isNonMd(activeFile);
  const tabs = useTabs(index ? openablePaths : null, activeFile, setActiveFile);
  // A non-md file has no comments; don't fetch (404s /api/comments).
  // Also hold off until the index loads — until then a deep-linked file's type is
  // unknown, and fetching comments for a non-md file would 404.
  const comments = useComments(typeKnown && !commentsUnavailable ? activeFile : null);
  const user = index?.user ?? "user";
  // Modal-open state (declared up here so the background-scroll-lock effect
  // below can read both; the modals themselves render much further down).
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Cancels an in-flight momentum drain (see the scroll-lock effect) if a modal
  // reopens before the drain expires, so it can't swallow the new panel's scrolls.
  const drainCancel = useRef<(() => void) | null>(null);
  // Remember scroll position per file so switching tabs returns to where you
  // were; restore is driven by the paint signal below.
  const { onDocPainted, onNoRestore } = useDocScroll(activeFile);

  // --- Live state -----------------------------------------------------------
  // One shared SSE stream watches every open tab's file; events route by file.
  // The active doc gets a reload banner / live comment refresh; background tabs
  // get an unread dot (and, for doc changes, a stale flag so focus reloads).
  const [docChanged, setDocChanged] = useState(false); // active doc changed on disk
  const [docReloadNonce, setDocReloadNonce] = useState(0); // bump → Doc re-fetches
  const reloadDoc = useCallback(() => {
    setDocChanged(false);
    setDocReloadNonce((n) => n + 1);
  }, []);

  const onSidecarChanged = useCallback(
    (file: string) => {
      if (file === activeFile) {
        comments.reload(); // live re-render of the on-screen doc's threads
      } else {
        tabs.markUnread(file);
      }
      reloadIndex(); // open-thread counts in the nav stay current
    },
    [activeFile, comments, tabs, reloadIndex],
  );
  // Per-file edit mode (view ⇄ edit), kept here rather than in the persisted tab
  // model so it survives tab switches but not reloads. A file in this set renders
  // the editor; others render the rendered doc.
  const [editingFiles, setEditingFiles] = useState<Set<string>>(new Set());

  // When the active surface is NOT a restoring <Doc> (non-md/editor), it
  // never fires onAnchorsPainted — so settle the scroll-switch handshake here,
  // or a later md→doc switch restores against stale state. Mirrors the render
  // branch below; runs once the type is known (before that we render a blank).
  const nonRestoringSurface =
    activeFile != null &&
    typeKnown &&
    (isNonMd(activeFile) || editingFiles.has(activeFile));
  useEffect(() => {
    if (nonRestoringSurface) onNoRestore();
  }, [nonRestoringSurface, activeFile, onNoRestore]);

  // Save status of the active editor, surfaced next to the filename in the toolbar.
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error" | "conflict"
  >("idle");

  // The active doc's body (frontmatter stripped) that feeds the outline pane.
  // Fed by Doc on load (view mode) and Editor on each keystroke (edit mode), so
  // the outline tracks live edits. Cleared on file switch so the outline never
  // shows the previous doc's headings while the new one loads.
  const [outlineContent, setOutlineContent] = useState<string | null>(null);
  const [viewRawContent, setViewRawContent] = useState<string | null>(null);
  const [suggestionPreview, setSuggestionPreview] = useState<SuggestionPreviewRequest | null>(null);
  const [replyPrompt, setReplyPrompt] = useState<ReplyPrompt | null>(null);
  const [editorRawContent, setEditorRawContent] = useState<string | null>(null);
  // Whether the editor buffer is exactly what's on disk. Tracked separately from
  // `saveState`, which is too coarse: it reads "saving" for a value newer typing
  // has already replaced, and Copy contents needs per-value freshness.
  //
  // Mirrored into a ref because Copy contents must read the buffer as it is at
  // click time. The editor publishes synchronously on every keystroke, so a
  // click in the same tick as an edit would otherwise see the pre-edit state
  // captured by the last render — copying stale text and calling it saved.
  const editorCopyState = useRef<{ raw: string | null; saved: boolean }>({ raw: null, saved: true });
  const onEditorRawContentChange = useCallback((raw: string, saved: boolean) => {
    editorCopyState.current = { raw, saved };
    setEditorRawContent(raw);
  }, []);
  // What the drawing canvas or HTML surface last rendered, on the same
  // click-time-read basis as the editor buffer above. One ref serves both:
  // only one of those surfaces is mounted at a time.
  //
  // The snapshot carries its file because it arrives from async loads and
  // saves — a reply that outlives a tab switch is discarded rather than
  // credited to the newly-open file.
  const surfaceCopyState = useRef<{ file: string; raw: string; saved: boolean } | null>(null);
  const onDrawingRawContentChange = useCallback((file: string, raw: string, saved: boolean) => {
    surfaceCopyState.current = { file, raw, saved };
  }, []);
  // HTML has no editable buffer, so what rendered is always exact disk text.
  const onHtmlRawContentLoaded = useCallback((file: string, raw: string) => {
    surfaceCopyState.current = { file, raw, saved: true };
  }, []);
  const [editorAnchorYs, setEditorAnchorYs] = useState<CommentAnchorY[]>([]);
  const [editorHost, setEditorHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setOutlineContent(null);
    setViewRawContent(null);
    setEditorRawContent(null);
    editorCopyState.current = { raw: null, saved: true };
    setEditorAnchorYs([]);
    setSuggestionPreview(null);
    setReplyPrompt(null);
  }, [activeFile]);
  // A reload tears the surface down and re-fetches, so the snapshot it published
  // describes a version nobody is looking at any more. Clearing on the reload
  // signal as well as the file keeps Copy contents honest in the window before
  // the new source renders — and when nothing renders at all, which is what a
  // reloaded app file does: trust is per-hash, so an externally edited app comes
  // back untrusted and stops at the trust prompt. Copy contents then falls back
  // to an on-demand read instead of serving the pre-reload text.
  useEffect(() => {
    surfaceCopyState.current = null;
  }, [activeFile, docReloadNonce]);
  const toggleEdit = useCallback((file: string) => {
    // Markdown swaps surfaces and reloads on a switch. A drawing keeps one live
    // canvas across modes, so a conflict banner remains until its Reload action.
    if (!isDrawing(file)) setDocChanged(false);
    setSuggestionPreview(null);
    setEditingFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, [isDrawing]);
  // Content an editor surface last wrote per file, so we can ignore the disk-change
  // event our own save echoes back (the watcher can't tell our write from an
  // external edit, and the event lands AFTER the save resolves — so a time-based
  // flag races it; matching the exact content is race-free).
  // Per file, the last few contents WE wrote (recorded at send time, capped).
  // A ring rather than a single slot: one write can echo as several watcher
  // events, events can outrun the PUT response, and overlapping saves can
  // interleave — a single consumed-on-match entry misreads all of those as
  // external changes.
  const lastWritten = useRef<Map<string, string[]>>(new Map());
  const onEditorDirty = useCallback(
    (file: string, _dirty: boolean, savedContent?: string) => {
      if (savedContent === undefined) return;
      const arr = lastWritten.current.get(file) ?? [];
      arr.push(savedContent);
      if (arr.length > 8) arr.shift();
      lastWritten.current.set(file, arr);
    },
    [],
  );
  const onDrawingWrite = useCallback(
    (file: string, content: string) => onEditorDirty(file, false, content),
    [onEditorDirty],
  );

  const editorRef = useRef<EditorHandle | null>(null);
  const onDocChanged = useCallback(
    (file: string) => {
      // View mode adopts drawing changes immediately. Edit mode first compares
      // disk bytes with recent autosaves so our own watcher echo never banners.
      if (isDrawing(file)) {
        const flagDrawingChange = () => {
          if (file === activeFile) {
            if (editingFiles.has(file)) setDocChanged(true);
            else {
              setDocChanged(false);
              setDocReloadNonce((nonce) => nonce + 1);
            }
          } else {
            tabs.markUnread(file);
            tabs.markStale(file);
          }
        };
        const recent = lastWritten.current.get(file);
        if (recent) {
          fetchDrawing(file)
            .then((drawing) => {
              if (!recent.includes(drawing.content)) flagDrawingChange();
            })
            .catch(() => {
              /* read failed — leave it; a later event will retry */
            });
        } else {
          flagDrawingChange();
        }
        return;
      }
      // A genuine external change to the active file: in edit mode it's a
      // conflict for the editor (which pauses autosave and offers a real
      // theirs-vs-yours choice); in view mode it's the opt-in reload banner —
      // never an auto-rerender.
      const flagActiveChange = () => {
        if (editingFiles.has(file)) editorRef.current?.notifyExternalChange();
        else setDocChanged(true);
      };
      // Suppress the self-reload: if the file on disk matches ANY recent own
      // write, this doc-changed is our own echo, not an external edit.
      if (lastWritten.current.has(file)) {
        const recent = lastWritten.current.get(file)!;
        fetchDoc(file)
          .then((doc) => {
            if (recent.includes(doc.content)) return;
            // Content differs → a genuine external change after our save.
            if (file === activeFile) flagActiveChange();
            else {
              tabs.markUnread(file);
              tabs.markStale(file);
            }
          })
          .catch(() => {
            /* read failed — leave it; a later event will retry */
          });
        return;
      }
      if (file === activeFile) {
        flagActiveChange();
      } else {
        tabs.markUnread(file);
        tabs.markStale(file); // focusing this tab later reloads its content
      }
    },
    [activeFile, tabs, editingFiles, isDrawing],
  );
  // `mdc open` while the server is up: open the file as a tab and focus it, in
  // place — no new browser tab. Open in a new app-tab (or focus if already open).
  const onOpenFile = useCallback(
    (file: string) => {
      tabs.openInNewTab(file);
    },
    [tabs],
  );
  const openFiles = useMemo(() => tabs.tabs.map((t) => t.file), [tabs.tabs]);
  useLiveReload(openFiles, { onSidecarChanged, onDocChanged, onOpenFile });

  // Switching to a tab whose doc went stale in the background reloads it once.
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeId);
  useEffect(() => {
    if (activeTab?.docStale && activeFile) {
      tabs.clearStale(activeFile);
      setDocChanged(false);
      setDocReloadNonce((n) => n + 1);
    }
  }, [activeTab?.docStale, activeFile, tabs]);

  // A file switch clears any stale doc-changed banner from the previous file.
  useEffect(() => {
    setDocChanged(false);
  }, [activeFile]);

  // --- Handoff --------------------------------------------------------------
  // Presence (is an agent watching, on which file) drives the toolbar cluster.
  // Hand off fires the live signal; with no agent connected it falls back to
  // copying the review command. End session asks for confirmation first.
  const presence = usePresence();
  const toast = useToast();
  const assetBlockedInView =
    activeFile !== null && typeKnown && !isNonMd(activeFile) && !editingFiles.has(activeFile);
  const onViewModePaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (!assetBlockedInView || event.clipboardData.getData("text/plain")) return;
      const hasImage = Array.from(event.clipboardData.items).some(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (!hasImage) return;
      event.preventDefault();
      toast.show({ title: "Switch to Edit to add images", meta: "" });
    },
    [assetBlockedInView, toast],
  );
  const onViewModeDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!assetBlockedInView || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
    },
    [assetBlockedInView],
  );
  const onViewModeDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!assetBlockedInView || event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      toast.show({ title: "Switch to Edit to add images", meta: "" });
    },
    [assetBlockedInView, toast],
  );
  const root = index?.root ?? "";
  const [confirmEnd, setConfirmEnd] = useState(false);

  // The server already injects this title into index.html, so normally this is
  // a no-op that just keeps the two in sync. It still earns its place for the
  // Vite dev server, which serves index.html without passing through Hono.
  useEffect(() => {
    const title = root ? `mdc — ${workspaceRootName(root)}` : "";
    if (title && document.title !== title) document.title = title;
  }, [root]);

  // A natural-language prompt matching the agent's activation rule (see
  // docs/agent-setup.md). Absolute path, matching the Workspace section's
  // convention (an agent's cwd may differ from the root).
  //
  // This used to read "Review <path> in mdc", chosen to be mode-neutral. In
  // practice agents read "review" as an instruction to PRODUCE one and open by
  // writing their own notes — burying the threads the user is waiting on, which
  // is the opposite of why the button was pressed. The button means "I left you
  // something," so the prompt now says that and names the command that finds it.
  const reviewPrompt = useCallback(
    () =>
      `Pick up my edits and comments on ${absolutePath(root, activeFile ?? "")} in mdc — ` +
      `run mdc list-pending on it first and reply in the margin. ` +
      `Don't add review notes of your own unless I ask for them.`,
    [root, activeFile],
  );

  // Copy filename / path / contents from the toolbar ⋮. The toast echoes the
  // copied value, truncated from the left so the filename stays visible — an
  // absolute path routinely outruns the toast width. The clipboard gets the
  // full value.
  //
  // Contents may need an async read, so each attempt takes a rising id and both
  // the write and the toast re-check it: the last action the user invoked wins,
  // even if an earlier read or clipboard promise resolves after it.
  const copyAttempt = useRef(0);
  const copyQueue = useRef<Promise<unknown>>(Promise.resolve());
  const copy = useCallback(
    (
      title: string,
      produce: () => string | Promise<string>,
      meta?: (value: string) => string,
      onReadError?: () => void,
    ) => {
      const attempt = ++copyAttempt.current;
      copyQueue.current = copyQueue.current.then(async () => {
        if (attempt !== copyAttempt.current) return;
        let value: string;
        try {
          value = await produce();
        } catch {
          // A failed source read must never reach the clipboard, and never
          // replace it with a partial value.
          if (attempt === copyAttempt.current) onReadError?.();
          return;
        }
        if (attempt !== copyAttempt.current) return;
        const ok = await copyToClipboard(value);
        if (attempt !== copyAttempt.current) return;
        toast.show(
          ok
            ? {
                title,
                meta: meta ? meta(value) : value,
                truncateMetaFromStart: true,
              }
            : { title: "Copy failed", meta: "Clipboard access is unavailable." },
        );
      });
    },
    [toast],
  );

  // Whether a file offers Copy contents at all. One predicate shared by the
  // toolbar ⋮ and the tree's row menu, so the two item sets cannot drift apart
  // for the same file.
  const hasCopyableContents = useCallback(
    (file: string | null) =>
      offersCopyContents({ file, typeKnown, isImage: isImage(file), isPdf: isPdf(file) }),
    [typeKnown, isImage, isPdf],
  );

  // Each action takes the file it acts on, because the toolbar and the file tree
  // disagree about what that is: the toolbar always means the open file, while
  // the tree means the right-clicked row, which need not be open at all.
  const onCopyFilename = useCallback(
    (file: string) => copy("Copied filename", () => filename(file)),
    [copy],
  );
  const onCopyPath = useCallback(
    (file: string) => copy("Copied path", () => absolutePath(root, file)),
    [root, copy],
  );

  // Copy contents copies what is ON SCREEN, which is not always what is on disk:
  // the edit buffer before autosave, the editable side of a conflict review, a
  // pinned suggestion's proposed text, the live drawing canvas before its
  // debounced write, or — behind the doc-changed banner — the snapshot still
  // displayed rather than the newer value nobody has seen.
  //
  // Each surface publishes into a ref, read at click time rather than as of the
  // last render: a surface can publish synchronously in the same tick as the
  // click, and React state would still hold the pre-publish value.
  //
  // Only the ACTIVE file has a displayed version at all: a tree row that isn't
  // open renders nowhere, so it is always read from disk at its own type.
  const onCopyContents = useCallback(
    (file: string) => {
      const name = filename(file);
      const active = file === activeFile;
      let displayed: string | null = null;
      let saved = true;
      let read: () => Promise<string>;
      if (isDrawing(file) || isHtml(file)) {
        // A snapshot tagged with another file is a reply that outlived a tab
        // switch — discard it and fall back to a read.
        const state = surfaceCopyState.current;
        if (active && state?.file === file) {
          displayed = state.raw;
          saved = state.saved;
        }
        read = isDrawing(file)
          ? () => fetchDrawing(file).then((d) => d.content)
          : () => fetchHtmlFile(file);
      } else {
        const editing = editingFiles.has(file);
        const editorState = editorCopyState.current;
        if (active) {
          displayed = editing ? editorState.raw : viewRawContent;
          saved = editing ? editorState.saved : true;
        }
        read = () => fetchDoc(file).then((d) => d.content);
      }
      // Unsaved beats reload-pending: an unsaved buffer or canvas is the user's
      // own work, whereas the banner is only about a change they haven't adopted.
      // Both describe the active surface, so neither applies to a disk read.
      const suffix =
        displayed === null ? "" : !saved ? " · unsaved" : docChanged ? " · reload pending" : "";
      copy(
        "Copied contents",
        // A surface that hasn't published its source yet — a trust prompt with no
        // HTML rendered behind it, a drawing mid-load — falls back to a disk read
        // rather than copying nothing.
        () => (displayed !== null ? displayed : read()),
        (value) => `${name} · ${formatSize(byteSize(value))}${suffix}`,
        () =>
          toast.show({
            title: "Copy failed",
            meta: `Couldn't read ${name}. It may have moved or been deleted.`,
          }),
      );
    },
    [activeFile, editingFiles, viewRawContent, docChanged, copy, toast, isDrawing, isHtml],
  );

  const onHandoff = useCallback(async () => {
    const session = presence.active;
    const prompt = reviewPrompt();
    // Try the live signal only when a session exists on THIS file; the server's
    // `delivered` is the source of truth (an agent may have dropped since the
    // last poll). Anything else copies the prompt so the user can start one.
    // NOTE: the "mdc-review" intent string is the wire protocol (aliased to
    // "review" in src/handoff.ts) — NOT the stale copied command. Leave it.
    if (session && session.file === activeFile) {
      try {
        const delivered = await postHandoffDone(session.sessionId, "mdc-review");
        presence.refresh();
        if (delivered) {
          // Mode-neutral: a bare hand-off on a clean doc is a valid "review my
          // draft" — don't claim the agent is reading comments that may not exist.
          toast.show({ title: "Handed off", meta: "The agent will take a look." });
          return;
        }
      } catch {
        await copyToClipboard(prompt);
        toast.show({ title: prompt, meta: "Wake-up failed — prompt copied as fallback", paste: true });
        return;
      }
    }
    // No agent watching. Serve both audiences: the copied prompt wakes a wired
    // agent; the pointer sends a not-yet-set-up user to the setup section.
    const ok = await copyToClipboard(prompt);
    toast.show(
      ok
        ? {
            // The prompt is on the clipboard; don't echo it in the toast — show
            // the two orienting lines instead (a blank line between, via .toast-hint).
            title: "No agent watching",
            meta: "Review prompt copied — paste it to your agent to start.",
            hint: "No agent set up yet? See Settings → Agent setup.",
          }
        : { title: prompt, meta: "Clipboard copy failed — select & copy manually" },
    );
  }, [presence, activeFile, reviewPrompt, toast]);

  const onEndSession = useCallback(async () => {
    setConfirmEnd(false);
    const session = presence.active;
    if (!session || session.file !== activeFile) return;
    editorRef.current?.closeSuggestionPreview();
    try {
      await postHandoffDone(session.sessionId, "done");
      toast.show({ title: "Session ended", meta: "The agent will stop watching." });
      presence.refresh();
    } catch {
      toast.show({ title: "End session failed", meta: "Could not reach the agent." });
    }
  }, [presence, activeFile, toast]);

  // A heading to scroll to once the next document has rendered (cross-doc
  // wikilink targets like [[file#section]]). Cleared by Doc after it scrolls.
  const [pendingSection, setPendingSection] = useState<string | null>(null);

  // Highlight↔card coordination: the doc paints highlights and reports its body
  // element (for anchor-context capture), the highlight overlay (where the rects
  // live, for card-Y measuring), and which threads orphaned. `paintTick` bumps on
  // each repaint so cards re-position.
  const [docRoot, setDocRoot] = useState<HTMLElement | null>(null);
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const [paintTick, setPaintTick] = useState(0);
  const [cardFocus, setCardFocus] = useState<CardFocus | null>(null);
  const onAnchorsPainted = useCallback(
    (root: HTMLElement | null, overlay: HTMLElement | null, ids: string[]) => {
      setDocRoot(root);
      setOverlayRoot(overlay);
      setOrphanIds(ids);
      setPaintTick((t) => t + 1);
      // Restore this file's saved scroll position once the doc actually rendered
      // (root non-null — NOT the empty "loading" paint, which fires first with a
      // collapsed page) — unless a section jump (wikilink #heading) owns scroll.
      if (root) onDocPainted(pendingSection !== null);
    },
    [onDocPainted, pendingSection],
  );
  // Rects moved (layout shift, no re-match): re-measure cards against fresh rect
  // positions, without the scroll-restore that onAnchorsPainted does.
  const onHighlightsRepositioned = useCallback(() => setPaintTick((t) => t + 1), []);
  // Open vs Resolved view in the comment sidebar.
  const [sidebarView, setSidebarView] = useState<SidebarView>("open");
  useEffect(() => setSidebarView("open"), [activeFile]);
  // Keep the latest suggestion data behind the stable mark handler so highlight
  // repaints do not have to rebind their DOM click listeners.
  const highlightPreviewContext = useRef({
    threads: comments.threads,
    entries: comments.entries,
    rawContent: viewRawContent,
    orphanIds: [] as string[],
  });
  const focusThreadCard = useCallback(
    (commentId: string, viewOverride?: SidebarView, options?: { scroll?: boolean }) => {
      const thread = comments.threads.find((t) => t.top.id === commentId);
      const view = viewOverride ?? (thread?.resolved ? "resolved" : "open");
      if (panels.sidebarCollapsed) panels.toggle("sidebar");
      if (sidebarView !== view) setSidebarView(view);
      setCardFocus((prev) => ({
        threadId: commentId,
        view,
        nonce: (prev?.nonce ?? 0) + 1,
        scroll: options?.scroll ?? true,
      }));
    },
    [comments.threads, panels, sidebarView],
  );
  // The mark-click handler must stay identity-stable: it's a dep of the doc's
  // highlight-paint effects, so a per-render identity would clear and repaint
  // the rects on every render — wiping hover state under the cursor and
  // dropping clicks that straddle a repaint. Read the live focus path via a ref.
  const focusThreadCardRef = useRef(focusThreadCard);
  focusThreadCardRef.current = focusThreadCard;
  const promptDismissalReason = useCallback(
    (threadId: string) => {
      setReplyPrompt((current) => ({
        threadId,
        nonce: (current?.nonce ?? 0) + 1,
      }));
      focusThreadCard(threadId, "open", { scroll: false });
    },
    [focusThreadCard],
  );
  const onReplyPromptShown = useCallback(() => setReplyPrompt(null), []);
  // Latest suggestion data behind the stable mark handler, so the editor's
  // underline clicks can pin without rebinding its click extension.
  const editMarkContext = useRef({ entries: comments.entries, editing: false });
  editMarkContext.current = {
    entries: comments.entries,
    editing: activeFile !== null && editingFiles.has(activeFile),
  };
  const onHighlightClick = useCallback((commentId: string) => {
    // A suggestion mark pins its preview in either mode — the inline merge
    // chunk in edit mode, the in-document diff in view mode. Decided, stale,
    // or unmappable suggestions fall back to focus-only. A pin owns the page
    // position (the user is already at the text), so the card is flashed
    // without the centring scroll that would yank the click away.
    const { entries: editEntries, editing } = editMarkContext.current;
    if (editing) {
      const entry = actionableSuggestion(editEntries, commentId);
      if (entry?.suggestion && editorRef.current?.previewSuggestion(commentId, entry.id, entry.suggestion)) {
        focusThreadCardRef.current(commentId, "open", { scroll: false });
        return;
      }
      focusThreadCardRef.current(commentId, "open");
      return;
    }
    const { threads, entries, rawContent, orphanIds } = highlightPreviewContext.current;
    const thread = threads.find((candidate) => candidate.top.id === commentId);
    const suggestionEntry = actionableSuggestion(entries, commentId);
    if (
      thread &&
      !thread.resolved &&
      !orphanIds.includes(commentId) &&
      suggestionEntry?.suggestion &&
      rawContent !== null &&
      findTargetStrict(suggestionEntry.suggestion.target, rawContent) !== null
    ) {
      setSuggestionPreview({
        threadId: commentId,
        suggestionId: suggestionEntry.id,
        suggestion: suggestionEntry.suggestion,
      });
      focusThreadCardRef.current(commentId, "open", { scroll: false });
      return;
    }
    focusThreadCardRef.current(commentId, "open");
  }, []);
  useEffect(() => {
    if (!cardFocus) return;
    let tries = 0;
    let raf = 0;
    const selector =
      cardFocus.view === "resolved"
        ? `.resolved-item[data-sidebar-id="${CSS.escape(cardFocus.threadId)}"]`
        : `.comment[data-sidebar-id="${CSS.escape(cardFocus.threadId)}"]`;
    const tryFocus = () => {
      if (!panels.sidebarCollapsed && sidebarView === cardFocus.view) {
        const card = document.querySelector<HTMLElement>(selector);
        if (card && card.offsetParent !== null) {
          if (cardFocus.scroll) card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.classList.remove("flash");
          requestAnimationFrame(() => card.classList.add("flash"));
          setTimeout(() => {
            card.classList.remove("flash");
            setCardFocus((current) => (current?.nonce === cardFocus.nonce ? null : current));
          }, 1300);
          return;
        }
      }
      if (tries++ < 80) raf = requestAnimationFrame(tryFocus);
      else setCardFocus(null);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [cardFocus, panels.sidebarCollapsed, sidebarView, comments.threads]);
  const commentLines = useMemo(
    () => resolveCommentLines(editorRawContent ?? "", comments.threads),
    [editorRawContent, comments.threads],
  );
  // Orphanhood is decided by the RENDERED doc (view-mode anchor resolution)
  // only. The edit-mode raw-text matcher can't resolve a quote that crosses
  // markdown syntax (**bold**, `code`), so "no raw match" must not be read as
  // "orphaned" — those threads just aren't positionable while editing. While a
  // file is being edited this carries the last view-mode determination.
  const viewOrphanIds = useMemo(() => {
    if (!activeFile) return [];
    const openThreadIds = new Set(comments.threads.filter((thread) => !thread.resolved).map((thread) => thread.top.id));
    return orphanIds.filter((id) => openThreadIds.has(id));
  }, [activeFile, comments.threads, orphanIds]);
  highlightPreviewContext.current = {
    threads: comments.threads,
    entries: comments.entries,
    rawContent: viewRawContent,
    orphanIds: viewOrphanIds,
  };
  const viewOrphanKey = viewOrphanIds.join("\0");
  const acknowledgedOrphans = useRef<Map<string, Set<string>>>(new Map());
  const [orphanNotice, setOrphanNotice] = useState<{
    file: string;
    ids: string[];
    newCount: number;
  } | null>(null);
  useEffect(() => {
    if (!activeFile || editingFiles.has(activeFile) || viewOrphanIds.length === 0) {
      setOrphanNotice(null);
      return;
    }
    const acknowledged = acknowledgedOrphans.current.get(activeFile) ?? new Set<string>();
    const newIds = viewOrphanIds.filter((id) => !acknowledged.has(id));
    setOrphanNotice(
      newIds.length > 0 ? { file: activeFile, ids: viewOrphanIds, newCount: newIds.length } : null,
    );
  }, [activeFile, editingFiles, viewOrphanIds, viewOrphanKey]);
  const acknowledgeOrphans = useCallback((file: string, ids: string[]) => {
    acknowledgedOrphans.current.set(file, new Set(ids));
    setOrphanNotice(null);
  }, []);
  const viewFirstOrphan = useCallback(() => {
    if (!orphanNotice) return;
    focusThreadCard(orphanNotice.ids[0]!, "open");
    acknowledgeOrphans(orphanNotice.file, orphanNotice.ids);
  }, [acknowledgeOrphans, focusThreadCard, orphanNotice]);
  const resolveVisibleOrphans = useCallback(async () => {
    if (!activeFile || !orphanNotice) return;
    const ids = orphanNotice.ids;
    await postResolveOrphans(activeFile, ids);
    acknowledgeOrphans(activeFile, ids);
    setSidebarView("resolved");
    comments.reload();
    reloadIndex();
    focusThreadCard(ids[0]!, "resolved");
  }, [activeFile, acknowledgeOrphans, comments, focusThreadCard, orphanNotice, reloadIndex]);
  const onCommentAnchorYsChange = useCallback((next: CommentAnchorY[]) => {
    setEditorAnchorYs((prev) => {
      if (
        prev.length === next.length &&
        prev.every((anchor, index) => {
          const other = next[index];
          return other && anchor.commentId === other.commentId && Math.abs(anchor.y - other.y) < 0.5;
        })
      ) {
        return prev;
      }
      return next;
    });
  }, []);
  const onEditModeSuggestionPreview = useCallback(
    (threadId: string, suggestionId: string, suggestion: Suggestion) => {
      editorRef.current?.scrollToComment(threadId);
      editorRef.current?.previewSuggestion(threadId, suggestionId, suggestion);
    },
    [],
  );
  const onCommentCardClick = useCallback((commentId: string) => {
    editorRef.current?.scrollToComment(commentId);
  }, []);

  // Outline row → scroll the rendered doc to that heading. The slug already
  // matches the heading's id (outline and renderer share slugify), so target it
  // directly rather than re-slugifying. Only meaningful in view mode — docRoot is
  // the rendered body, absent in edit mode (the pane guards the click there).
  const onScrollToHeading = useCallback(
    (slug: string) => {
      if (!docRoot) return;
      const escaped = window.CSS && CSS.escape ? CSS.escape(slug) : slug;
      const target = docRoot.querySelector(`#${escaped}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [docRoot],
  );

  const navigate = useCallback(
    (file: string, section?: string, newTab?: boolean) => {
      setPendingSection(section ?? null);
      if (newTab) tabs.openInNewTab(file);
      else tabs.open(file);
    },
    [tabs],
  );

  // Create flow: a pending comment is the selection captured from the doc, shown
  // as a composer card in the margin until submitted or cancelled.
  const [pending, setPending] = useState<PendingComment | null>(null);
  // The pending selection's live range, kept so the preview highlight and the
  // composer's margin position can re-derive after any reflow (sidebar
  // auto-open, panel toggle, window resize) — layout geometry captured at start
  // goes stale the moment the column rewraps.
  const pendingRange = useRef<Range | null>(null);

  const onStartPending = useCallback((root: HTMLElement, range: Range) => {
    const quote = range.toString().trim();
    if (!quote) return;
    // Capture everything anchor-building needs BEFORE mutating the DOM with the
    // preview highlight (which would shift the offset map).
    const list = document.querySelector<HTMLElement>(".comment-list, .sidebar-inner");
    const listRect = list?.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const anchorY = listRect ? rect.top - listRect.top + (list?.scrollTop ?? 0) : rect.top;
    const blockText = enclosingBlockText(range.startContainer);
    const renderedOffset = renderedOffsetOf(root, range);
    pendingRange.current = range.cloneRange();
    if (overlayRoot) applyPreviewHighlight(overlayRoot, range);
    window.getSelection()?.removeAllRanges();
    setPending({ quote, anchorY, blockText, renderedOffset });
    // The composer lives in the comment sidebar — surface it if it's collapsed.
    // The reflow this causes is caught by the reposition effect below.
    if (panels.sidebarCollapsed) panels.toggle("sidebar");
  }, [overlayRoot, panels]);

  // Re-derive the pending preview + composer position after any reflow, on the
  // same signal the committed highlights repaint on (paintTick). The stored
  // range stays valid across reflows (layout moves text, not DOM nodes).
  useEffect(() => {
    const range = pendingRange.current;
    if (!range || !overlayRoot) return;
    applyPreviewHighlight(overlayRoot, range);
    const list = document.querySelector<HTMLElement>(".comment-list, .sidebar-inner");
    const listRect = list?.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const anchorY = listRect ? rect.top - listRect.top + (list?.scrollTop ?? 0) : rect.top;
    setPending((p) => (p && p.anchorY !== anchorY ? { ...p, anchorY } : p));
  }, [paintTick, overlayRoot]);

  const cancelPending = useCallback(() => {
    pendingRange.current = null;
    clearPreviewHighlight(overlayRoot);
    setPending(null);
  }, [overlayRoot]);

  const submitPending = useCallback(
    async (body: string) => {
      if (!body.trim() || !pending || !activeFile || !docRoot) return;
      const { content } = await fetchDoc(activeFile);
      const anchor: NewAnchor = { quote: pending.quote };
      const line = resolveLine(content, pending.quote, pending.blockText);
      if (line !== null) anchor.line = line;
      const context = computeAnchorContext(docRoot, pending.quote, pending.renderedOffset);
      if (context) anchor.context = context;
      await postComment(activeFile, { author: user, body, anchor, parent_id: null });
      pendingRange.current = null;
      clearPreviewHighlight(overlayRoot);
      setPending(null);
      comments.reload();
    },
    [pending, activeFile, docRoot, overlayRoot, user, comments],
  );

  // A file switch abandons any in-progress composition.
  useEffect(() => {
    pendingRange.current = null;
    setPending(null);
    clearPreviewHighlight(overlayRoot);
  }, [activeFile]);

  const onReply = useCallback(
    async (threadId: string, body: string) => {
      if (!activeFile || !body.trim()) return;
      await postComment(activeFile, { author: user, body, parent_id: threadId, anchor: null });
      comments.reload();
    },
    [activeFile, user, comments],
  );
  const onResolve = useCallback(
    async (threadId: string) => {
      if (!activeFile) return;
      await postResolve(activeFile, threadId, user);
      comments.reload();
    },
    [activeFile, user, comments],
  );
  const onApplySuggestion = useCallback(
    async (threadId: string, suggestionId: string, suggestion: Suggestion) => {
      if (!activeFile) {
        setSuggestionPreview(null);
        return "error" as const;
      }
      if (editingFiles.has(activeFile)) {
        if (editorRef.current?.acceptSuggestionPreview(threadId, suggestionId)) {
          return "applied" as const;
        }
        if (!editorRef.current?.applySuggestion(suggestion)) {
          setSuggestionPreview(null);
          return "stale" as const;
        }
        try {
          await postResolve(activeFile, threadId, user, "applied", suggestionId);
          setSuggestionPreview(null);
          comments.reload();
          reloadIndex();
          toast.show({ title: "Suggestion applied", meta: "The editor was updated." });
          return "applied" as const;
        } catch {
          toast.show({
            title: "Couldn't resolve suggestion",
            meta: "The editor change remains in the document.",
          });
          setSuggestionPreview(null);
          return "error" as const;
        }
      }
      try {
        const result = await postApplySuggestion(activeFile, threadId, suggestionId, user);
        const recent = lastWritten.current.get(activeFile) ?? [];
        recent.push(result.content);
        if (recent.length > 8) recent.shift();
        lastWritten.current.set(activeFile, recent);
        setSuggestionPreview(null);
        reloadDoc();
        comments.reload();
        reloadIndex();
        toast.show({ title: "Suggestion applied", meta: "The document was updated." });
        return "applied" as const;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setSuggestionPreview(null);
          comments.reload();
          // Refresh the raw content used by the card's strict preflight so a
          // stale decision takes the same orphaned path as a card decision.
          reloadDoc();
          return "stale" as const;
        }
        setSuggestionPreview(null);
        toast.show({ title: "Couldn't apply suggestion", meta: "The document was not changed." });
        return "error" as const;
      }
    },
    [activeFile, comments, editingFiles, reloadDoc, reloadIndex, toast, user],
  );
  const onDismissSuggestion = useCallback(
    async (threadId: string, suggestionId: string) => {
      if (!activeFile) {
        setSuggestionPreview(null);
        return;
      }
      if (editingFiles.has(activeFile) && editorRef.current?.dismissSuggestionPreview(threadId, suggestionId)) {
        setSuggestionPreview(null);
        return;
      }
      try {
        await postDismissSuggestion(activeFile, threadId, suggestionId, user);
        setSuggestionPreview(null);
        comments.reload();
        reloadIndex();
        promptDismissalReason(threadId);
      } catch (error) {
        setSuggestionPreview(null);
        throw error;
      }
    },
    [activeFile, comments, editingFiles, promptDismissalReason, reloadIndex, user],
  );
  const onEditModeSuggestionDecision = useCallback(
    async (threadId: string, suggestionId: string, resolution: "applied" | "dismissed") => {
      if (!activeFile) return;
      try {
        if (resolution === "applied") {
          await postResolve(activeFile, threadId, user, "applied", suggestionId);
        } else {
          await postDismissSuggestion(activeFile, threadId, suggestionId, user);
        }
        comments.reload();
        reloadIndex();
        if (resolution === "applied") {
          toast.show({
            title: "Suggestion applied",
            meta: "The editor change will be saved.",
          });
        } else {
          promptDismissalReason(threadId);
        }
      } catch {
        toast.show({
          title:
            resolution === "applied"
              ? "Couldn't resolve suggestion"
              : "Couldn't dismiss suggestion",
          meta: resolution === "applied" ? "The editor change remains in the document." : "The editor was restored.",
        });
      }
    },
    [activeFile, comments, promptDismissalReason, reloadIndex, toast, user],
  );
  const onPreviewSuggestion = useCallback(
    (threadId: string, suggestionId: string, suggestion: Suggestion) => {
      setSuggestionPreview({ threadId, suggestionId, suggestion });
    },
    [],
  );
  const closeSuggestionPreview = useCallback(() => setSuggestionPreview(null), []);
  const onSuggestionPreviewUnavailable = useCallback((suggestionId: string) => {
    setSuggestionPreview((current) =>
      current?.suggestionId === suggestionId ? null : current,
    );
  }, []);
  const onUnresolve = useCallback(
    async (threadId: string) => {
      if (!activeFile) return;
      await postUnresolve(activeFile, threadId, user);
      comments.reload();
    },
    [activeFile, user, comments],
  );
  const onEdit = useCallback(
    async (commentId: string, body: string) => {
      if (!activeFile || !body.trim()) return;
      await postEdit(activeFile, commentId, body, user);
      comments.reload();
    },
    [activeFile, user, comments],
  );
  // Delete is confirmed via a blocking dialog: the card asks to delete, App holds
  // the pending target + renders the modal, then performs it on confirm.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const confirmDelete = useCallback(async () => {
    const id = deleteTarget;
    setDeleteTarget(null);
    if (!id || !activeFile) return;
    await postDelete(activeFile, id, user);
    comments.reload();
  }, [deleteTarget, activeFile, user, comments]);

  // With no file open, lock the layout to the viewport (no scroll) so the
  // centered empty prompts sit in a stable, full-height frame. (Settings is a
  // modal over the app, so it doesn't change this lock.)
  useEffect(() => {
    document.body.classList.toggle("app-empty", !activeFile);
    return () => document.body.classList.remove("app-empty");
  }, [activeFile]);

  // An iframe or drawing surface fills the viewport with its own interaction area, so the
  // OUTER page must not also scroll. Lock the layout to the viewport (same as
  // app-empty) while an iframe-backed view is active.
  useEffect(() => {
    document.body.classList.toggle(
      "iframe-active",
      isHtml(activeFile) || isPdf(activeFile) || isDrawing(activeFile),
    );
    return () => document.body.classList.remove("iframe-active");
  }, [activeFile, isHtml, isPdf, isDrawing]);

  // Freeze background scroll while a modal (settings / ⌘K) is open. A non-passive
  // wheel handler cancels any scroll that wouldn't be consumed by an actually-
  // scrollable region INSIDE the modal panel. Testing "inside the panel" alone
  // isn't enough: a short panel (e.g. the Appearance section) has nothing to
  // scroll, so an allowed wheel there bubbles to the window and scrolls the doc
  // behind. So we walk up from the target looking for an ancestor (within the
  // panel) that can scroll in the wheel's direction; if none, block it.
  //
  // On macOS, a hard trackpad fling against the blocked page keeps inertial
  // momentum alive in the OS, and it is released the instant the listeners
  // detach on close — drifting the page. So a close that follows a just-blocked
  // wheel hands off to a temporary drain handler that keeps swallowing wheel
  // events until they go quiet (momentum spent) before detaching for real. A
  // calm close (no wheel blocked in the last 100ms) detaches immediately.
  useEffect(() => {
    if (!settingsOpen && !cmdkOpen) return;
    drainCancel.current?.();
    const panel = () =>
      document.querySelector<HTMLElement>(".settings-modal") ??
      document.querySelector<HTMLElement>(".cmdk-panel");
    const consumesScroll = (e: WheelEvent): boolean => {
      const p = panel();
      let node = e.target instanceof Node ? (e.target as HTMLElement | null) : null;
      const dy = e.deltaY;
      while (node && node !== p?.parentElement) {
        if (node instanceof HTMLElement) {
          const canScroll = node.scrollHeight > node.clientHeight;
          if (canScroll) {
            const atTop = node.scrollTop <= 0;
            const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
            // This element can absorb the wheel unless it's already pinned at the
            // edge the wheel is pushing against (then the scroll would chain out).
            if (!((dy < 0 && atTop) || (dy > 0 && atBottom))) return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    };
    let lastBlocked = 0;
    const onWheel = (e: WheelEvent) => {
      if (!consumesScroll(e)) {
        e.preventDefault();
        lastBlocked = performance.now();
      }
    };
    const onTouch = (e: TouchEvent) => {
      // Touch has no delta direction here; allow only inside the panel (its own
      // scroller handles overscroll), block everything else (the background).
      const p = panel();
      if (!(e.target instanceof Node && p?.contains(e.target))) e.preventDefault();
    };
    // Scroll keys are the third scroll input besides wheel and touch. Blocked
    // only when the event targets the background — keys inside the panel keep
    // their meaning (arrows navigate the ⌘K list, Space types into its input).
    const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      const p = panel();
      if (!(e.target instanceof Node && p?.contains(e.target))) e.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("touchmove", onTouch, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("keydown", onKeyDown);
      // Momentum drain: only when a fling was in flight at close. Momentum wheel
      // events arrive near-continuously, so a 150ms silent gap means it's spent;
      // the hard cap bounds the worst case.
      if (performance.now() - lastBlocked > 100) return;
      let quiet: number | undefined;
      let cap: number | undefined;
      const stop = () => {
        window.removeEventListener("wheel", drain);
        clearTimeout(quiet);
        clearTimeout(cap);
        drainCancel.current = null;
      };
      const drain = (e: WheelEvent) => {
        e.preventDefault();
        clearTimeout(quiet);
        quiet = window.setTimeout(stop, 150);
      };
      window.addEventListener("wheel", drain, { passive: false });
      quiet = window.setTimeout(stop, 150);
      cap = window.setTimeout(stop, 1500);
      drainCancel.current = stop;
    };
  }, [settingsOpen, cmdkOpen]);

  // Global shortcuts, matched against the keymap table (web/src/keymap.ts) so
  // bindings + the Settings cheatsheet share one source of truth. Esc-close is a
  // modal concern, kept inline. The comment shortcut is owned by the doc
  // view, which has the live selection — it's listed in the table but not here.
  useEffect(() => {
    // True when focus is in any text-entry surface — a real <textarea>/<input>
    // (the comment composer) OR a contenteditable (the CodeMirror editor renders
    // .cm-content as contenteditable, NOT a textarea). Shortcuts that collide
    // with typing (⌥←/→ = move-by-word, ⌘K) bail when this holds.
    const inTextField = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "TEXTAREA" || tag === "INPUT" || (el as HTMLElement).isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && settingsOpen) {
        e.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (matchEvent(e, combo("jump-file"))) {
        if (inTextField()) return;
        e.preventDefault();
        setCmdkOpen((v) => !v);
      } else if (matchEvent(e, combo("tab-prev"))) {
        if (inTextField()) return; // ⌥← is "move by word" while editing
        e.preventDefault();
        tabs.cycle(-1);
      } else if (matchEvent(e, combo("tab-next"))) {
        if (inTextField()) return;
        e.preventDefault();
        tabs.cycle(1);
      } else if (matchEvent(e, combo("switch-pane"))) {
        e.preventDefault();
        pane.toggle();
      } else if (matchEvent(e, combo("toggle-nav"))) {
        e.preventDefault();
        panels.toggle("nav");
      } else if (matchEvent(e, combo("toggle-sidebar"))) {
        e.preventDefault();
        if (!commentsUnavailable) panels.toggle("sidebar");
      } else if (matchEvent(e, combo("toggle-edit"))) {
        if (!activeFile || (isNonMd(activeFile) && !isDrawing(activeFile))) return;
        e.preventDefault();
        toggleEdit(activeFile);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    panels,
    pane,
    tabs,
    activeFile,
    toggleEdit,
    isNonMd,
    isDrawing,
    commentsUnavailable,
    settingsOpen,
  ]);

  // --- Dashboard ------------------------------------------------------------
  // The cross-doc review inbox now lives inside the settings modal (the Comments
  // section). Poll while settings is open so the data is fresh on arrival.
  const dashboard = useDashboard(settingsOpen);

  // --- Settings -------------------------------------------------------------
  // Settings is a centered modal over a dimmed backdrop (it doesn't take over
  // the layout, so the nav hotkeys stay irrelevant while it's open). It's the
  // entry point features dock into. (`settingsOpen` is declared earlier so the
  // Esc-close shortcut can read it.)
  const openSettings = useCallback(() => setSettingsOpen((o) => !o), []);
  // NOTE: background scroll is NOT locked while a modal is open — see the
  // settings-modal-scroll-lock task. A first attempt (position:fixed pin)
  // conflicted with useDocScroll's save/restore and nudged the doc on close.
  // On close, drop focus off the trigger (the footer gear) so it doesn't keep a
  // focus-visible ring after an Esc/backdrop close.
  const prevSettingsOpen = useRef(settingsOpen);
  useEffect(() => {
    if (prevSettingsOpen.current && !settingsOpen) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    prevSettingsOpen.current = settingsOpen;
  }, [settingsOpen]);

  // Jump from an inbox row into the doc + scroll/flash the thread's card.
  const onJump = useCallback(
    (file: string, threadId: string, resolved: boolean, newTab: boolean) => {
      setSettingsOpen(false);
      if (newTab) tabs.openInNewTab(file);
      else tabs.open(file);
      focusThreadCard(threadId, resolved ? "resolved" : "open");
    },
    [focusThreadCard, tabs],
  );

  // Dashboard deletes: a thread (soft, append-only) or a whole sidecar (hard).
  // Both go behind a confirm; on confirm, refresh the inbox and — if the touched
  // doc is the active one — its live comment sidebar too.
  const [dashConfirm, setDashConfirm] = useState<
    | { kind: "thread"; file: string; threadId: string }
    | { kind: "sidecar"; file: string; count: number; orphaned: boolean }
    | null
  >(null);
  const onDeleteThread = useCallback(
    (file: string, threadId: string) => setDashConfirm({ kind: "thread", file, threadId }),
    [],
  );
  const onDeleteSidecar = useCallback(
    (file: string, count: number, orphaned: boolean) =>
      setDashConfirm({ kind: "sidecar", file, count, orphaned }),
    [],
  );
  const runDashDelete = useCallback(async () => {
    const c = dashConfirm;
    setDashConfirm(null);
    if (!c) return;
    if (c.kind === "thread") await deleteThreadInFile(c.file, c.threadId, user);
    else await deleteSidecar(c.file);
    await dashboard.refresh();
    if (c.file === activeFile) comments.reload();
  }, [dashConfirm, user, dashboard, activeFile, comments]);

  // --- File tree create / delete --------------------------------------------
  // Create writes the file/folder, refreshes the index so the nav shows it,
  // and (for a doc) opens it in edit mode. Delete goes behind a confirm that
  // states the stakes (a folder's doc + comment counts come from a pre-flight).
  const onCreateFile = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const created = await createFile(path);
        // Record the initial bytes so the resulting
        // doc-changed watcher event is recognized as our own and doesn't raise
        // a reload banner (same echo-suppression the editor save uses).
        lastWritten.current.set(path, [created.content]);
        reloadIndex();
        tabs.openInNewTab(path); // a create is a NEW doc → its own tab, never in-place
        setEditingFiles((prev) => new Set(prev).add(path)); // fresh empty doc → edit mode
        return true;
      } catch (e) {
        const msg = e instanceof ApiError && e.status === 409 ? "Already exists" : "Couldn't create file";
        toast.show({ title: msg, meta: path });
        return false;
      }
    },
    [reloadIndex, tabs, toast],
  );
  const onCreateFolder = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        await createFolder(path);
        reloadIndex();
        return true;
      } catch (e) {
        const msg = e instanceof ApiError && e.status === 409 ? "Already exists" : "Couldn't create folder";
        toast.show({ title: msg, meta: path });
        return false;
      }
    },
    [reloadIndex, toast],
  );

  // Pending file/folder delete, resolved by a confirm dialog. A folder carries
  // its pre-flight counts so the confirm can state how much it removes.
  const [fileDelete, setFileDelete] = useState<
    | { kind: "file"; path: string }
    | { kind: "folder"; path: string; docs: number; withComments: number }
    | null
  >(null);
  const onRequestDeleteFile = useCallback((path: string) => {
    setFileDelete({ kind: "file", path });
  }, []);
  const onRequestDeleteFolder = useCallback(
    async (path: string) => {
      let docs = 0;
      let withComments = 0;
      try {
        const s = await fetchFolderSummary(path);
        docs = s.docs;
        withComments = s.withComments;
      } catch {
        // Summary failed — still allow the delete, just without exact counts.
      }
      setFileDelete({ kind: "folder", path, docs, withComments });
    },
    [],
  );
  const runFileDelete = useCallback(async () => {
    const t = fileDelete;
    setFileDelete(null);
    if (!t) return;
    try {
      if (t.kind === "file") {
        await deleteFile(t.path);
        // Close any tab on the deleted file so the strip doesn't show a ghost.
        const tab = tabs.tabs.find((x) => x.file === t.path);
        if (tab) tabs.close(tab.id);
      } else {
        await deleteFolder(t.path);
        // Close tabs whose file lived under the deleted folder.
        const prefix = `${t.path}/`;
        for (const tab of tabs.tabs.filter((x) => x.file.startsWith(prefix))) tabs.close(tab.id);
      }
      reloadIndex();
    } catch {
      toast.show({ title: "Delete failed", meta: t.path });
    }
  }, [fileDelete, tabs, reloadIndex, toast]);

  // --- File tree move (drag-to-reorganize) ----------------------------------
  // A drop requests a move INTO a folder; we fetch the blast-radius preview and
  // hold it for a confirm. On confirm the move runs, open tabs follow the new
  // path, and the index refreshes. `from` is a doc or folder; `to` is its new
  // full path (destFolder + its own name).
  const [movePending, setMovePending] = useState<MovePreview | null>(null);
  const onRequestMove = useCallback(
    async (from: string, destFolder: string) => {
      const name = from.split("/").pop() ?? from;
      const to = destFolder ? `${destFolder}/${name}` : name;
      try {
        const preview = await fetchMovePreview(from, to);
        setMovePending(preview);
      } catch {
        toast.show({ title: "Can't move there", meta: to });
      }
    },
    [toast],
  );
  const runMove = useCallback(async () => {
    const p = movePending;
    setMovePending(null);
    if (!p) return;
    try {
      const res = await moveFile(p.from, p.to);
      tabs.remap(p.from, p.to); // open tabs follow the new path
      reloadIndex();
      const links = res.linksRewritten;
      toast.show({
        title: `Moved ${basename(p.to)}`,
        meta: links ? `${links} link${links === 1 ? "" : "s"} updated` : "",
      });
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 409 ? "A file already exists there" : "Move failed";
      toast.show({ title: msg, meta: p.to });
    }
  }, [movePending, tabs, reloadIndex, toast]);

  const layoutClass = [
    "layout",
    panels.navCollapsed ? "nav-collapsed" : "",
    panels.sidebarCollapsed || commentsUnavailable ? "sidebar-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={layoutClass}>
      <aside className="nav">
        <Nav
          root={index?.root ?? ""}
          paths={openablePaths}
          images={images}
          htmls={htmls}
          pdfs={pdfs}
          drawings={drawings}
          dirs={dirs}
          activeFile={activeFile}
          activeContent={outlineContent}
          canScrollDoc={!(activeFile != null && editingFiles.has(activeFile))}
          tabs={tabs}
          pane={pane.pane}
          onSelectPane={pane.select}
          onToggle={() => panels.toggle("nav")}
          onOpenFile={tabs.open}
          onOpenInNewTab={tabs.openInNewTab}
          onScrollToHeading={onScrollToHeading}
          onOpenSettings={openSettings}
          onCreateFile={onCreateFile}
          onCreateFolder={onCreateFolder}
          onRequestDeleteFile={onRequestDeleteFile}
          onRequestDeleteFolder={onRequestDeleteFolder}
          onRequestMove={onRequestMove}
          onCopyFilename={onCopyFilename}
          onCopyPath={onCopyPath}
          onCopyContents={onCopyContents}
          offersCopyContents={hasCopyableContents}
        />
      </aside>

      <div
        className="doc-area"
        onPaste={onViewModePaste}
        onDragOver={onViewModeDragOver}
        onDrop={onViewModeDrop}
      >
        <div className="doc-shell">
          <DocToolbar
            activeFile={activeFile}
            session={presence.active}
            onHandoff={onHandoff}
            onEndSession={() => setConfirmEnd(true)}
            // The toolbar's target is always the open file; the tree binds these
            // same actions to the right-clicked row instead.
            onCopyFilename={() => activeFile && onCopyFilename(activeFile)}
            onCopyPath={() => activeFile && onCopyPath(activeFile)}
            // Every text surface — markdown, drawings, HTML. Images and PDFs
            // never get it (no text to copy). Withheld until the index resolves
            // the type: before that every file looks like markdown, so a
            // deep-linked image would offer a copy that 404s.
            onCopyContents={
              activeFile && hasCopyableContents(activeFile)
                ? () => onCopyContents(activeFile)
                : undefined
            }
            navCollapsed={panels.navCollapsed}
            sidebarCollapsed={panels.sidebarCollapsed}
            onToggleNav={() => panels.toggle("nav")}
            onToggleSidebar={() => panels.toggle("sidebar")}
            editing={!!activeFile && editingFiles.has(activeFile)}
            // Drawings share the markdown mode toggle; other non-markdown surfaces stay view-only.
            onToggleEdit={activeFile && (!isNonMd(activeFile) || isDrawing(activeFile)) ? () => toggleEdit(activeFile) : undefined}
            saveState={activeFile && editingFiles.has(activeFile) ? saveState : "idle"}
            isNonMd={isNonMd(activeFile)}
          />
          {docChanged && activeFile && (
            <DocBanner
              text={isDrawing(activeFile) ? "This drawing changed on disk." : "This doc changed on disk."}
              actions={[{ label: "↻ Reload", onClick: reloadDoc }]}
            />
          )}
          {orphanNotice && (
            <DocBanner
              className="orphan-doc-banner"
              text={`${orphanNotice.newCount} comment${orphanNotice.newCount === 1 ? "" : "s"} lost their anchor.`}
              actions={[
                { label: "View", onClick: viewFirstOrphan },
                { label: "Resolve all orphaned", onClick: resolveVisibleOrphans },
              ]}
              onDismiss={() => acknowledgeOrphans(orphanNotice.file, orphanNotice.ids)}
              dismissLabel="Dismiss orphaned comments notice"
            />
          )}
          <div className="doc-area-inner">
            {activeFile && !typeKnown ? (
              // Index not loaded yet → file type unknown. Render a blank surface
              // rather than guess "doc" (which would 404 /api/md + /api/comments
              // for a non-md file before the index corrects the routing).
              <div className="doc" />
            ) : activeFile && isImage(activeFile) ? (
              <ImageView file={activeFile} reloadNonce={docReloadNonce} />
            ) : activeFile && isHtml(activeFile) ? (
              <HtmlSurface
                file={activeFile}
                reloadNonce={docReloadNonce}
                onRawContentLoaded={onHtmlRawContentLoaded}
              />
            ) : activeFile && isPdf(activeFile) ? (
              <PdfView file={activeFile} reloadNonce={docReloadNonce} />
            ) : activeFile && isDrawing(activeFile) ? (
              <Suspense fallback={<div className="doc drawing-view" />}>
                <ExcalidrawView
                  file={activeFile}
                  editing={editingFiles.has(activeFile)}
                  reloadNonce={docReloadNonce}
                  externalChange={docChanged}
                  onOwnWrite={onDrawingWrite}
                  onSaveStateChange={setSaveState}
                  onConflict={() => setDocChanged(true)}
                  onRawContentChange={onDrawingRawContentChange}
                />
              </Suspense>
            ) : activeFile && editingFiles.has(activeFile) ? (
              <Editor
                ref={editorRef}
                file={activeFile}
                commentLines={commentLines}
                onCommentMarkerClick={onHighlightClick}
                onDirtyChange={onEditorDirty}
                onSaveStateChange={setSaveState}
                onContentChange={setOutlineContent}
                onRawContentChange={onEditorRawContentChange}
                onCommentAnchorYsChange={onCommentAnchorYsChange}
                onEditorHostChange={setEditorHost}
                onSuggestionPreviewDecision={onEditModeSuggestionDecision}
                onAssetError={(message) => toast.show({ title: message, meta: "" })}
                onAssetCreated={reloadIndex}
              />
            ) : (
              <Doc
                file={activeFile}
                paths={paths}
                onNavigate={navigate}
                scrollToSection={pendingSection}
                onSectionScrolled={() => setPendingSection(null)}
                threads={comments.threads}
                onHighlightClick={onHighlightClick}
                onAnchorsPainted={onAnchorsPainted}
                onHighlightsRepositioned={onHighlightsRepositioned}
                onStartPending={onStartPending}
                pendingActive={!!pending}
                reloadNonce={docReloadNonce}
                onContentLoaded={(body, rawContent) => {
                  setOutlineContent(body);
                  setViewRawContent(rawContent);
                }}
                suggestionPreview={suggestionPreview}
                onCloseSuggestionPreview={closeSuggestionPreview}
                onApplySuggestion={onApplySuggestion}
                onDismissSuggestion={onDismissSuggestion}
                onSuggestionPreviewUnavailable={onSuggestionPreviewUnavailable}
              />
            )}
          </div>
        </div>
      </div>

      <aside className="sidebar">
        <div className="sidebar-inner">
          <Comments
            threads={comments.threads}
            entries={comments.entries}
            rawContent={
              activeFile && editingFiles.has(activeFile) ? editorRawContent : viewRawContent
            }
            orphanIds={viewOrphanIds}
            user={user}
            overlayRoot={overlayRoot}
            hasFile={!!activeFile}
            paintTick={paintTick}
            collapsed={panels.sidebarCollapsed || commentsUnavailable}
            view={sidebarView}
            onView={setSidebarView}
            pending={pending}
            onSubmitPending={submitPending}
            onCancelPending={cancelPending}
            onReply={onReply}
            onResolve={onResolve}
            onApplySuggestion={onApplySuggestion}
            onDismissSuggestion={onDismissSuggestion}
            replyPrompt={replyPrompt}
            onReplyPromptShown={onReplyPromptShown}
            onPreviewSuggestion={onPreviewSuggestion}
            onUnresolve={onUnresolve}
            onEdit={onEdit}
            onRequestDelete={setDeleteTarget}
            onCollapse={() => panels.toggle("sidebar")}
            editing={!!activeFile && editingFiles.has(activeFile)}
            editAnchorYs={editorAnchorYs}
            editorHost={editorHost}
            onEditModeCardClick={onCommentCardClick}
            onEditModeSuggestionPreview={onEditModeSuggestionPreview}
          />
        </div>
      </aside>

      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          root={index?.root ?? ""}
          version={index?.mdcVersion ?? null}
          dashboardData={dashboard.data}
          onJump={onJump}
          onDeleteThread={onDeleteThread}
          onDeleteSidecar={onDeleteSidecar}
        />
      )}

      {cmdkOpen && (
        <CmdK
          paths={openablePaths}
          onClose={() => setCmdkOpen(false)}
          onPick={(file) => {
            setCmdkOpen(false);
            // Open in a NEW tab (focus it if already open) rather than replacing
            // the active tab — a palette pick is "show me this", not "navigate
            // here". Sidebar clicks + wikilinks keep tabs.open (in-place).
            tabs.openInNewTab(file);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this comment?"
          message="This can't be undone."
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {confirmEnd && (
        <ConfirmDialog
          title="End this review session?"
          message="The agent stops watching this doc. You can hand off again later to restart."
          confirmLabel="End session"
          onConfirm={onEndSession}
          onCancel={() => setConfirmEnd(false)}
        />
      )}

      {dashConfirm && (
        <ConfirmDialog
          title={
            dashConfirm.kind === "thread"
              ? "Delete this whole thread?"
              : dashConfirm.orphaned
                ? `Delete ${dashConfirm.count} stranded comment${dashConfirm.count === 1 ? "" : "s"}?`
                : `Delete all ${dashConfirm.count} comment${dashConfirm.count === 1 ? "" : "s"} on this doc?`
          }
          message={
            dashConfirm.kind === "thread"
              ? "Removes the comment and all its replies. This can't be undone."
              : dashConfirm.orphaned
                ? `The source doc ${dashConfirm.file} was deleted; this removes its leftover comments for good. This can't be undone.`
                : `Removes every comment thread on ${dashConfirm.file}. This can't be undone.`
          }
          confirmLabel={
            dashConfirm.kind === "thread" || dashConfirm.orphaned ? "Delete" : "Delete all"
          }
          onConfirm={runDashDelete}
          onCancel={() => setDashConfirm(null)}
        />
      )}

      {fileDelete && (
        <ConfirmDialog
          title={
            fileDelete.kind === "file"
              ? `Delete ${basename(fileDelete.path)}?`
              : `Delete ${basename(fileDelete.path)}/?`
          }
          message={
            fileDelete.kind === "file"
              ? isImage(fileDelete.path)
                ? "Removes this image. This can't be undone."
                : isHtml(fileDelete.path)
                  ? "Removes this HTML file. This can't be undone."
                  : isPdf(fileDelete.path)
                    ? "Removes this PDF file. This can't be undone."
                    : isDrawing(fileDelete.path)
                      ? "Removes this drawing. This can't be undone."
                    : "Removes the document and its comments. This can't be undone."
              : folderDeleteMessage(fileDelete.docs, fileDelete.withComments)
          }
          onConfirm={runFileDelete}
          onCancel={() => setFileDelete(null)}
        />
      )}

      {movePending && (
        <ConfirmDialog
          title={`Move ${basename(movePending.from)} → ${basename(parentOf(movePending.to)) || "root"}?`}
          message={moveMessage(movePending)}
          confirmLabel="Move"
          tone="primary"
          onConfirm={runMove}
          onCancel={() => setMovePending(null)}
        />
      )}

      {toast.toast && <Toast toast={toast.toast} />}
    </div>
  );
}

/** The last path segment (file or folder name) of a root-relative path. */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The parent-folder path of a root-relative path (root = ""). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Move confirm copy: the blast radius (docs relocated, sidecars, links rewritten). */
function moveMessage(p: MovePreview): string {
  if (p.collisions.length) {
    return `A file already exists at ${p.collisions[0]}. Move blocked.`;
  }
  const parts: string[] = [];
  parts.push(`${p.docsToMove} document${p.docsToMove === 1 ? "" : "s"}`);
  if (p.sidecarsToRelocate > 0) {
    parts.push(`${p.sidecarsToRelocate} comment file${p.sidecarsToRelocate === 1 ? "" : "s"}`);
  }
  const moved = `Relocates ${parts.join(" and ")}.`;
  const links =
    p.linksToRewrite > 0
      ? ` Updates ${p.linksToRewrite} link${p.linksToRewrite === 1 ? "" : "s"} across ${p.docsToRewrite} doc${p.docsToRewrite === 1 ? "" : "s"}.`
      : " No links need updating.";
  return moved + links;
}

/** Folder-delete confirm copy stating how many docs (and how many with comments) go. */
function folderDeleteMessage(docs: number, withComments: number): string {
  if (docs === 0) return "Removes this empty folder. This can't be undone.";
  const docPart = `${docs} document${docs === 1 ? "" : "s"}`;
  const commentPart = withComments > 0 ? ` (${withComments} with comments)` : "";
  return `Removes ${docPart}${commentPart} and all their comments. This can't be undone.`;
}

/** Copy text to the clipboard; returns whether it succeeded. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
